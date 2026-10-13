import { readFileSync } from 'node:fs';

import { skillManifestSchema } from '@agent-works/domain';
import { reconcileIncident } from '@agent-works/incident-analysis';
import { decide } from '@agent-works/policy';

import { Unavailable } from '../auth/iap.js';
import { createBroker, TICKET_TOOL } from '../broker/broker.js';

import type { Caller } from '../auth/iap.js';
import type { ApprovalStore } from '../broker/approvals.js';
import type { Broker } from '../broker/broker.js';
import type { LedgerPort } from '../ports/ledger-port.js';
import type {
  PolicyDecision,
  SearchContext,
  SkillManifest,
  TaskAccepted,
  TaskSubmit,
} from '@agent-works/domain';
import type {
  Delivery,
  DeliverInput,
  IncidentExecution,
  IncidentModel,
} from '@agent-works/incident-analysis';
import type { PolicyFacts } from '@agent-works/policy';

export type AuthorizedCaller = {
  readonly caller: Caller;
  readonly context: SearchContext;
  readonly decision: Extract<PolicyDecision, { effect: 'allow' }>;
};

export type IncidentApprovalDeps = {
  readonly store: ApprovalStore;
  readonly ledger: LedgerPort;
  readonly now: () => Date;
  readonly reauthorize: (
    request: TaskSubmit,
    authorized: AuthorizedCaller,
  ) => Promise<{ facts: PolicyFacts; approverAuthorized: (sub: string) => boolean }>;
};

export type RegisteredSkill = {
  readonly manifest: SkillManifest;
  configureApprovals?(deps: IncidentApprovalDeps): void;
  validate(request: TaskSubmit): boolean;
  dispatch(
    request: TaskSubmit,
    accepted: TaskAccepted,
    authorized: AuthorizedCaller,
    execution?: IncidentExecution,
  ): Promise<void>;
};

export type IncidentSkill = RegisteredSkill & {
  result(taskId: string): Delivery | undefined;
};

export type IncidentConfig = {
  readonly incidentsUrl: string;
  readonly ticketsUrl: string;
  readonly model: IncidentModel;
};

/* eslint-disable security/detect-non-literal-fs-filename -- fixed paths to the bundled skill files */
const skill = {
  manifest: skillManifestSchema.parse(
    JSON.parse(
      readFileSync(
        new URL('../../../../agents/skills/incident-analysis/manifest.json', import.meta.url),
        'utf8',
      ),
    ) as unknown,
  ),
  prompt: readFileSync(
    new URL('../../../../agents/skills/incident-analysis/prompts/analyze.md', import.meta.url),
    'utf8',
  ),
};
/* eslint-enable security/detect-non-literal-fs-filename */

export function createIncidentSkill(
  config: () => IncidentConfig | undefined = () => undefined,
  deliver?: (input: DeliverInput) => Promise<Delivery>,
): IncidentSkill {
  let approvalDeps: IncidentApprovalDeps | undefined;
  const ledger = new Map<string, string>();
  const results = new Map<string, Delivery>();
  const deadlines = new Map<string, number>();
  const inFlight = new Map<string, Promise<Delivery>>();
  const issuedWrites = new Set<string>();
  async function runDelivery(
    taskId: string,
    input: DeliverInput,
    operation: (input: DeliverInput) => Promise<Delivery>,
  ): Promise<Delivery> {
    const pending = inFlight.get(taskId);
    if (pending !== undefined) return pending;
    const started = operation(input);
    inFlight.set(taskId, started);
    try {
      return await started;
    } finally {
      inFlight.delete(taskId);
    }
  }
  const recover = async (taskId: string): Promise<boolean> => {
    if (ledger.has(taskId)) return true;
    const configured = issuedWrites.has(taskId) ? config() : undefined;
    if (configured === undefined) return false;
    const recovered = await reconcileIncident({
      ticketsUrl: configured.ticketsUrl,
      deliveryId: taskId,
      ledger,
    });
    if (recovered.kind !== 'written') return false;
    results.set(taskId, recovered);
    return true;
  };
  return {
    manifest: skill.manifest,
    configureApprovals: (deps) => {
      approvalDeps = deps;
    },
    result: (taskId) => {
      const receipt = ledger.get(taskId);
      return receipt === undefined ? results.get(taskId) : { kind: 'written', ticketId: receipt };
    },
    validate: (request) =>
      typeof request.input?.incidentId === 'string' && request.input.incidentId.length > 0,
    async dispatch(request, accepted, authorized, execution) {
      const deadline = Math.min(
        deadlines.get(accepted.taskId) ?? Infinity,
        Date.parse(accepted.submittedAt) + request.executionPolicy.deadlineSeconds * 1000,
        execution?.deadline ?? Infinity,
      );
      deadlines.set(accepted.taskId, deadline);
      if (executionStopped(deadline, execution)) {
        if (await recover(accepted.taskId)) return;
        results.set(accepted.taskId, {
          kind: execution?.signal?.aborted ? 'cancelled' : 'timeout',
        });
        throw new Unavailable('incident');
      }
      const configured = config();
      if (configured === undefined) {
        results.set(accepted.taskId, { kind: 'failed' });
        throw new Unavailable('incident');
      }
      const incidentId = request.input?.incidentId;
      if (typeof incidentId !== 'string' || incidentId.length === 0)
        throw new Error('incident input');
      function brokerFor(
        input: DeliverInput,
        signal: AbortSignal,
        binding: Awaited<ReturnType<IncidentApprovalDeps['reauthorize']>> | undefined,
      ): Broker | undefined {
        if (approvalDeps === undefined || binding === undefined) return undefined;
        return createBroker({
          store: approvalDeps.store,
          ledger: approvalDeps.ledger,
          now: approvalDeps.now,
          decide,
          approverAuthorized: binding.approverAuthorized,
          postTicket: async (body, key) => {
            signal.throwIfAborted();
            issuedWrites.add(accepted.taskId);
            const posted = await fetch(new URL('/tickets', input.ticketsUrl), {
              method: 'POST',
              headers: { 'content-type': 'application/json', 'idempotency-key': key },
              body: JSON.stringify(body),
              signal,
            });
            if (!posted.ok) throw new Error('ticket');
            const receipt = (await posted.json()) as { id: string };
            if (typeof receipt.id !== 'string' || receipt.id.length === 0)
              throw new Error('ticket');
            return receipt.id;
          },
        });
      }
      async function approvedDelivery(input: DeliverInput): Promise<Delivery> {
        const known = ledger.get(accepted.taskId);
        if (known !== undefined) return { kind: 'written', ticketId: known };
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), Math.max(0, deadline - Date.now()));
        const signal = AbortSignal.any([
          controller.signal,
          ...(execution?.signal === undefined ? [] : [execution.signal]),
        ]);
        try {
          const response = await fetch(
            new URL(`/incidents/${encodeURIComponent(incidentId as string)}`, input.incidentsUrl),
            { signal },
          );
          if (!response.ok) throw new Error('incident');
          const incident = (await response.json()) as { id: string; title: string; note: string };
          const summary = await bounded(
            input.model.answer(
              `${skill.prompt}\n\nIncident ${incident.id}: ${incident.title}\n${incident.note}`,
              { deadline, signal },
            ),
            signal,
          );
          signal.throwIfAborted();
          const payload = { summary: summary.trim(), project: 'incidents' };
          const approvalId = request.input?.approvalId;
          if (typeof approvalId !== 'string') throw new Error('approval required');
          const binding = await approvalDeps?.reauthorize(request, authorized);
          const broker = brokerFor(input, signal, binding);
          if (broker === undefined) throw new Error('approval broker unavailable');
          const result = await broker.execute({
            id: `incident:${accepted.taskId}`,
            taskId: accepted.taskId,
            stepId: 'ticket',
            toolRef: TICKET_TOOL,
            idempotencyKey: accepted.taskId,
            targetResource: 'incidents',
            payload,
            approvalId,
            actorSub: authorized.caller.sub,
            traceId: accepted.traceId,
            facts: binding?.facts ?? {},
          });
          if (!result.ok) throw new Error(result.code);
          ledger.set(accepted.taskId, result.receipt);
          return { kind: 'written', ticketId: result.receipt };
        } catch {
          return {
            kind: deliveryFailure(deadline, execution?.signal),
          };
        } finally {
          clearTimeout(timer);
        }
      }
      const result = await runDelivery(
        accepted.taskId,
        {
          ...configured,
          callerContext: authorized.context,
          skill,
          deliveryId: accepted.taskId,
          incidentId,
          timeoutMs: request.executionPolicy.deadlineSeconds * 1000,
          deadline,
          signal: execution?.signal,
          ledger,
          issuedWrites,
        },
        deliver ?? approvedDelivery,
      ).catch((): Delivery => ({ kind: 'failed' }));
      results.set(accepted.taskId, result);
      if (result.kind === 'written') ledger.set(accepted.taskId, result.ticketId);
      else throw new Unavailable('incident');
    },
  };
}

async function bounded<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted();
  let abort = () => {};
  const stopped = new Promise<never>((_resolve, reject) => {
    abort = () => reject(new Error('incident stopped'));
    signal.addEventListener('abort', abort, { once: true });
  });
  try {
    return await Promise.race([operation, stopped]);
  } finally {
    signal.removeEventListener('abort', abort);
  }
}

function deliveryFailure(
  deadline: number,
  signal?: AbortSignal,
): 'cancelled' | 'timeout' | 'failed' {
  if (signal?.aborted) return 'cancelled';
  return Date.now() >= deadline ? 'timeout' : 'failed';
}
function executionStopped(deadline: number, execution?: IncidentExecution): boolean {
  return (
    !Number.isFinite(deadline) || Date.now() >= deadline || execution?.signal?.aborted === true
  );
}
