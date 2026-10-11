import { readFileSync } from 'node:fs';

import { skillManifestSchema } from '@agent-works/domain';
import { deliverIncident } from '@agent-works/incident-analysis';

import { Unavailable } from '../auth/iap.js';

import type { Caller } from '../auth/iap.js';
import type {
  PolicyDecision,
  SearchContext,
  SkillManifest,
  TaskAccepted,
  TaskSubmit,
} from '@agent-works/domain';
import type { Delivery, DeliverInput, IncidentModel } from '@agent-works/incident-analysis';

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
  ): Promise<void>;
};

export type IncidentConfig = {
  readonly incidentsUrl: string;
  readonly ticketsUrl: string;
  readonly model: IncidentModel;
};

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

export function createIncidentSkill(
  config: () => IncidentConfig | undefined = () => undefined,
  deliver: (input: DeliverInput) => Promise<Delivery> = deliverIncident,
): RegisteredSkill {
  const ledger = new Map<string, string>();
  return {
    manifest: skill.manifest,
    validate: (request) =>
      typeof request.input?.incidentId === 'string' && request.input.incidentId.length > 0,
    async dispatch(request, accepted, authorized) {
      const configured = config();
      if (configured === undefined) throw new Unavailable('incident');
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
        ledger,
      });
      if (result.kind !== 'written') throw new Unavailable('incident');
    },
  };
}
