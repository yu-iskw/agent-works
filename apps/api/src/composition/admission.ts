import type { AdmissionService } from '../admission/postgres-admission.js';
import type { Outcome } from '../admission/types.js';
import type { RegisteredSkill } from '../skills/incident.js';
import type { InvocationContext } from '@agent-works/policy';

export class AdmissionDenied extends Error {
  constructor(readonly reason: string) {
    super(`admission denied: ${reason}`);
    this.name = 'AdmissionDenied';
  }
}

export type AdmissionPolicy = {
  readonly segmentId: string;
  readonly estimatedCostMicros: number;
  readonly leaseMs: number;
  readonly now: () => Date;
  readonly teamsFor: (sub: string) => Promise<{ readonly groups: readonly string[] }>;
};

const agent = { kind: 'agent', id: 'api', version: '1' } as const;
const tool = { kind: 'tool', id: 'admission', version: '1' } as const;

/**
 * Reserves capacity before a skill runs and settles it when the run ends. A denial throws, so the
 * existing dispatcher retries the delivery with its own backoff rather than running unadmitted
 * work. A task is admitted once: a later attempt or an approval resume finds its reservation
 * already finished and rides on that first admission instead of being charged again.
 */
export function admittedSkill(
  skill: RegisteredSkill,
  admission: AdmissionService,
  policy: AdmissionPolicy,
  model: string,
): RegisteredSkill {
  return {
    ...skill,
    async dispatch(request, accepted, authorized, execution) {
      const teams = await policy.teamsFor(authorized.caller.sub);
      const invocation: InvocationContext = {
        subject: authorized.caller.sub,
        teams: teams.groups,
        agent,
        skill: { kind: 'skill', id: skill.manifest.id, version: skill.manifest.version },
        model,
        tool,
        taskId: accepted.taskId,
        traceId: accepted.traceId,
      };
      const verdict = await admission.admit({
        executionId: accepted.taskId,
        memberId: authorized.caller.sub,
        botId: skill.manifest.id,
        segmentId: policy.segmentId,
        windowKey: policy.now().toISOString().slice(0, 10),
        estimatedCostMicros: policy.estimatedCostMicros,
        invocation,
      });
      if (!verdict.admitted && verdict.reason !== 'already_finished')
        throw new AdmissionDenied(verdict.reason);
      const held = verdict.admitted;
      const renewal = held
        ? setInterval(
            () => {
              admission.renew(accepted.taskId).catch(() => undefined);
            },
            Math.max(1, Math.floor(policy.leaseMs / 3)),
          )
        : undefined;
      let outcome: Outcome = 'succeeded';
      try {
        await skill.dispatch(request, accepted, authorized, execution);
      } catch (error) {
        outcome = execution?.signal?.aborted === true ? 'cancelled' : 'failed';
        throw error;
      } finally {
        clearInterval(renewal);
        if (held) await admission.release(accepted.taskId, outcome).catch(() => undefined);
      }
    },
  };
}
