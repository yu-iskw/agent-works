import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';

import { capabilityPinSchema, outboxEventSchema, ticketCreateManifest } from '@agent-works/domain';

import { Unavailable } from '../auth/iap.js';
import { RetrievalError } from '../retrieval/drive-port.js';

import { InvocationStopped } from './enforcement.js';

import type { SuspensionEnforcer } from './enforcement.js';
import type { AgentRunner } from '../agent/runner-port.js';
import type { VerifyAssertion } from '../auth/iap.js';
import type { ExecuteInput } from '../broker/broker.js';
import type { LedgerPort } from '../ports/ledger-port.js';
import type { SuspensionAudit } from '../ports/suspension-ledger.js';
import type { RegisteredSkill } from '../skills/incident.js';
import type { CapabilityPin, CapabilityVersion } from '@agent-works/domain';
import type { InvocationContext } from '@agent-works/policy';
import type { RequestListener } from 'node:http';

const calls = new AsyncLocalStorage<{
  context: InvocationContext;
  enforce: SuspensionEnforcer;
  stopped?: InvocationStopped;
  admit?: boolean;
  resolveTeams?: () => Promise<void>;
}>();
const unavailableMessage = 'suspension unavailable';
const agent = { kind: 'agent', id: 'api', version: '1' } as const;
const ask = { kind: 'skill', id: 'ask', version: '1' } as const;
const search = { kind: 'tool', id: 'drive.search', version: '1' } as const;
const ticket = {
  kind: 'tool',
  id: ticketCreateManifest.metadata.name,
  version: ticketCreateManifest.metadata.version,
} as const;

export function bundledVersionBaseline(
  skill: RegisteredSkill['manifest'],
): readonly Pick<CapabilityVersion, 'pin' | 'reason'>[] {
  const pins: CapabilityPin[] = [agent, ask, search, ticket];
  if (skill.state === 'PUBLISHED')
    pins.push({ kind: 'skill', id: skill.id, version: skill.version });
  return pins.map((pin) => ({
    pin: capabilityPinSchema.parse(pin),
    reason: 'Bundled published capability',
  }));
}

/** Broker fallback hook is bound by the production entry point, without editing skill factories. */
export async function beforeToolCall(input: ExecuteInput): Promise<void> {
  const scope = calls.getStore();
  if (scope === undefined) return;
  const tool = parseTool(input.toolRef);
  try {
    await scope.enforce.check(
      {
        ...scope.context,
        taskId: input.taskId,
        traceId: input.traceId,
        tool,
      },
      'tool',
    );
  } catch (error) {
    if (error instanceof InvocationStopped) scope.stopped = error;
    throw error;
  }
}
export async function beforeModelCall(model: string): Promise<void> {
  const scope = calls.getStore();
  if (scope === undefined) return;
  try {
    await scope.resolveTeams?.();
    await scope.enforce.check({ ...scope.context, model }, 'model');
  } catch (error) {
    if (error instanceof InvocationStopped) scope.stopped = error;
    throw error;
  }
}
export async function beforeReadTool(): Promise<void> {
  const scope = calls.getStore();
  if (scope === undefined) return;
  try {
    await scope.enforce.check({ ...scope.context, tool: search }, 'tool');
  } catch (error) {
    if (error instanceof InvocationStopped) scope.stopped = error;
    throw new RetrievalError(error instanceof InvocationStopped ? error.code : unavailableMessage, {
      cause: error,
    });
  }
}
function parseTool(ref: string): CapabilityPin {
  const split = ref.lastIndexOf('@');
  return capabilityPinSchema.parse({
    kind: 'tool',
    id: ref.slice(0, split),
    version: ref.slice(split + 1),
  });
}
export function controlledRunner(runner: AgentRunner, enforcer: SuspensionEnforcer): AgentRunner {
  return {
    run(input) {
      return runner.run({
        ...input,
        beforeModelCall: async (model) => {
          const scope = calls.getStore();
          try {
            await scope?.resolveTeams?.();
            const context = scope?.context ?? emptyContext(model);
            await enforcer.check({ ...context, model }, 'model');
          } catch (error) {
            if (scope !== undefined && error instanceof InvocationStopped) scope.stopped = error;
            throw error;
          }
        },
      });
    },
  };
}
function emptyContext(model: string): InvocationContext {
  return {
    subject: '',
    teams: [],
    agent,
    skill: ask,
    tool: search,
    model,
    taskId: 'unbound',
    traceId: randomUUID(),
  };
}
export async function authorizeResource(
  manifest: RegisteredSkill['manifest'] | undefined,
  model: string,
): Promise<void> {
  const scope = calls.getStore();
  if (scope === undefined) return;
  if (manifest !== undefined)
    scope.context = {
      ...scope.context,
      skill: { kind: 'skill', id: manifest.id, version: manifest.version },
      tool: ticket,
      model,
    };
  try {
    await scope.resolveTeams?.();
    await scope.enforce.check(scope.context, 'admission');
  } catch (error) {
    throw new Unavailable(error instanceof InvocationStopped ? error.code : unavailableMessage, {
      cause: error,
    });
  }
}
export function controlledVerify(
  verify: VerifyAssertion,
  teamsFor: (sub: string) => Promise<{ groups: readonly string[] }>,
  enforcer: SuspensionEnforcer,
): VerifyAssertion {
  return async (assertion) => {
    const caller = await verify(assertion);
    const scope = calls.getStore();
    if (scope !== undefined) {
      scope.context = { ...scope.context, subject: caller.sub, teams: [] };
      // Ownership-only routes authenticate without depending on directory availability.
      scope.resolveTeams = async () => {
        const teams = await teamsFor(caller.sub);
        scope.context = { ...scope.context, teams: teams.groups };
        scope.resolveTeams = undefined;
      };
      // Admin operations must remain accessible while the global kill switch is active.
      if (scope.admit === true) {
        try {
          await scope.resolveTeams();
          await enforcer.check(scope.context, 'admission');
        } catch (error) {
          throw new Unavailable(
            error instanceof InvocationStopped ? error.code : unavailableMessage,
            { cause: error },
          );
        }
      }
    }
    return caller;
  };
}
export function controlledListener(
  listener: RequestListener,
  enforcer: SuspensionEnforcer,
): RequestListener {
  return (request, response) => {
    const id = randomUUID();
    const isAdmin =
      URL.parse(request.url ?? '/', 'http://localhost')?.pathname.startsWith('/v1/admin/') === true;
    const context = { ...emptyContext('gemini'), taskId: isAdmin ? 'admin' : id, traceId: id };
    // Keep async callbacks created by the existing listener inside the same invocation scope.
    const admit = URL.parse(request.url ?? '/', 'http://localhost')?.pathname === '/v1/ask';
    calls.run({ context, enforce: enforcer, admit }, () => listener(request, response));
  };
}
export function controlledSkill(
  skill: RegisteredSkill,
  enforcer: SuspensionEnforcer,
  teamsFor: (sub: string) => Promise<{ groups: readonly string[] }>,
  model: string,
): RegisteredSkill {
  const stopped = new Set<string>();
  return {
    ...skill,
    result: (taskId: string) =>
      stopped.has(taskId)
        ? { kind: 'revoked' as const }
        : 'result' in skill && typeof skill.result === 'function'
          ? (skill.result as (id: string) => unknown)(taskId)
          : undefined,
    async dispatch(request, accepted, authorized, execution) {
      const teams = await teamsFor(authorized.caller.sub);
      const context: InvocationContext = {
        subject: authorized.caller.sub,
        teams: teams.groups,
        agent,
        skill: { kind: 'skill', id: skill.manifest.id, version: skill.manifest.version },
        model,
        tool: ticket,
        taskId: accepted.taskId,
        traceId: accepted.traceId,
      };
      const scope: {
        context: InvocationContext;
        enforce: SuspensionEnforcer;
        stopped?: InvocationStopped;
        admit?: boolean;
      } = { context, enforce: enforcer };
      await calls.run(scope, async () => {
        try {
          await enforcer.check(context, 'admission');
          await skill.dispatch(request, accepted, authorized, execution);
          if (scope.stopped !== undefined) throw scope.stopped;
        } catch (error) {
          // The existing dispatcher understands the controlled 'revoked' result.
          if (error instanceof InvocationStopped || scope.stopped !== undefined)
            stopped.add(accepted.taskId);
          throw error;
        }
      });
    },
  } as RegisteredSkill;
}
export function emergencyAudit(ledger: LedgerPort): (event: SuspensionAudit) => Promise<void> {
  return async (event) => {
    await ledger.append(
      outboxEventSchema.parse({
        destination: 'audit',
        event: {
          eventId: event.eventId,
          eventType: event.eventType,
          schemaVersion: '1',
          occurredAt: event.occurredAt,
          taskId: event.taskId ?? 'admin',
          stepId: 'suspension',
          traceId: event.traceId,
          initiatorSubject: event.actorSub || 'unknown',
          agentPrincipal: 'agent:control-plane',
          tool: null,
          policyDecisionId: null,
          approvalId: null,
          requestDigestSha256: event.digest,
          outcome: 'DENIED',
          externalObjectRef: null,
          prevDigest: null,
        },
      }),
    );
  };
}
