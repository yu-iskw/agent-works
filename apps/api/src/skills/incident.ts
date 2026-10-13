import { readFileSync } from 'node:fs';

import { skillManifestSchema } from '@agent-works/domain';
import { deliverIncident, reconcileIncident } from '@agent-works/incident-analysis';

import { Unavailable } from '../auth/iap.js';

import type { Caller } from '../auth/iap.js';
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

export type AuthorizedCaller = {
  readonly caller: Caller;
  readonly context: SearchContext;
  readonly decision: Extract<PolicyDecision, { effect: 'allow' }>;
};

export type RegisteredSkill = {
  readonly manifest: SkillManifest;
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
  deliver: (input: DeliverInput) => Promise<Delivery> = deliverIncident,
): IncidentSkill {
  const ledger = new Map<string, string>();
  const results = new Map<string, Delivery>();
  const deadlines = new Map<string, number>();
  const issuedWrites = new Set<string>();
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
      if (!Number.isFinite(deadline) || Date.now() >= deadline || execution?.signal?.aborted) {
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
      const result = await deliver({
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
      }).catch((): Delivery => ({ kind: 'failed' }));
      results.set(accepted.taskId, result);
      if (result.kind === 'written') ledger.set(accepted.taskId, result.ticketId);
      else throw new Unavailable('incident');
    },
  };
}
