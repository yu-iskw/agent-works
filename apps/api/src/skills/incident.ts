import { readFileSync } from 'node:fs';

import { skillManifestSchema } from '@agent-works/domain';
import { deliverIncident } from '@agent-works/incident-analysis';

import { Unavailable } from '../auth/iap.js';

import type { SkillManifest, TaskAccepted, TaskSubmit } from '@agent-works/domain';
import type { Delivery, DeliverInput, IncidentModel } from '@agent-works/incident-analysis';

export type RegisteredSkill = {
  readonly manifest: SkillManifest;
  validate(request: TaskSubmit): boolean;
  dispatch(request: TaskSubmit, accepted: TaskAccepted): Promise<void>;
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
    async dispatch(request, accepted) {
      const configured = config();
      if (configured === undefined) throw new Unavailable('incident');
      const incidentId = request.input?.incidentId;
      if (typeof incidentId !== 'string' || incidentId.length === 0)
        throw new Error('incident input');
      const result = await deliver({
        ...configured,
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
