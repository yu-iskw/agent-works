import { createHash } from 'node:crypto';

import { scheduleHash, scheduleSpecSchema } from '@agent-works/domain';
import * as z from 'zod';

import { resolveStandingAuthority } from '../../authority-lifecycle/resolver.js';

import { validateProposal } from './validate.js';

import type { RoutineRecord, RoutineStore } from './types.js';
import type { RoutineDenial } from './validate.js';
import type { GrantActivation, GrantActor } from '../../authority-lifecycle/lifecycle.js';
import type { StandingAuthority } from '../../authority-lifecycle/resolver.js';
import type { GrantStore } from '../../authority-lifecycle/store.js';
import type { AuthorityResolver } from '../authority.js';
import type { ScheduleSpec } from '@agent-works/domain';
import type { StandingGrant } from '@agent-works/domain/standing-grant-contract';

/**
 * The scheduler side, kept to two calls. `create` must be idempotent on `spec.id` and must record
 * the consent the grant stands for; `revoke` must cancel queued and in-flight occurrences through
 * the existing revoke path and be safe to repeat.
 */
export type RoutineSchedules = {
  create(
    spec: ScheduleSpec,
    sponsor: string,
    consent: { readonly ref: string; readonly digest: string; readonly expiresAt: string },
  ): Promise<void>;
  revoke(sponsor: string, scheduleId: string): Promise<void>;
};

export type RoutineDeps = {
  readonly grants: GrantStore;
  readonly routines: RoutineStore;
  readonly schedules: RoutineSchedules;
  readonly activation: GrantActivation;
  readonly now: () => Date;
};

/** A proposal is untrusted data: this shape is all that is read from it. */
const proposalSchema = z.strictObject({
  grantId: z.string().min(1).max(200),
  idempotencyKey: z.string().min(1).max(128),
  kind: z.enum(['one_time', 'recurring']),
  spec: z.record(z.string(), z.unknown()),
});

export type ProposeResult =
  | { readonly ok: true; readonly routine: RoutineRecord; readonly replayed: boolean }
  | { readonly ok: false; readonly code: RoutineDenial };

export type RoutineVerdict =
  | { readonly allow: true }
  | { readonly allow: false; readonly reason: string; readonly cancelled: boolean };

export type CancelResult =
  | { readonly ok: true; readonly routine: RoutineRecord }
  | { readonly ok: false; readonly code: 'NOT_FOUND' | 'NOT_AUTHORIZED' };

/** Grant verdicts that can never recover, so the routine is cancelled rather than paused. */
const PERMANENT = new Set([
  'revoked',
  'expired',
  'not_yet_valid',
  'ancestor_unusable',
  'grant_not_found',
  'no_matching_permission',
]);

function routineIdFor(grantId: string, key: string): string {
  const h = createHash('sha256')
    .update(JSON.stringify([grantId, key]))
    .digest('hex');
  const variant = ((Number.parseInt(h.slice(16, 17), 16) & 0x3) | 0x8).toString(16);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-5${h.slice(13, 16)}-${variant}${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

type Intake =
  | { readonly code: RoutineDenial }
  | {
      readonly proposal: z.infer<typeof proposalSchema>;
      readonly chain: readonly StandingGrant[];
      readonly grant: StandingGrant;
    };

/** Activation, caller identity, shape and grant ownership, before any limit is looked at. */
async function intakeProposal(
  deps: RoutineDeps,
  actor: GrantActor,
  input: unknown,
): Promise<Intake> {
  if (!deps.activation.enabled) return { code: 'ACTIVATION_OFF' };
  if (actor.kind !== 'bot') return { code: 'NOT_AUTHORIZED' };
  const parsed = proposalSchema.safeParse(input);
  if (!parsed.success) return { code: 'INVALID_PROPOSAL' };
  const chain = await deps.grants.chain(parsed.data.grantId);
  const grant = chain.at(0);
  if (grant === undefined) return { code: 'GRANT_NOT_FOUND' };
  const mine = grant.grantee.botId === actor.botId && grant.grantee.botVersion === actor.botVersion;
  return mine ? { proposal: parsed.data, chain, grant } : { code: 'NOT_AUTHORIZED' };
}

type Stop = { readonly why: string; readonly cancelReason: string | null };

/** Null when the grant still backs the routine; otherwise why it does not and whether to cancel. */
function stopFor(answer: StandingAuthority, routine: RoutineRecord): Stop | null {
  if (answer.kind === 'granted') {
    return answer.sponsor === routine.sponsor
      ? null
      : { why: 'sponsor_changed', cancelReason: 'sponsor_changed' };
  }
  return {
    why: answer.reason,
    cancelReason: PERMANENT.has(answer.reason) ? `grant_${answer.reason}` : null,
  };
}

/** Re-reads the whole grant chain for each scope pair; the first denial decides. */
async function checkGrant(deps: RoutineDeps, routine: RoutineRecord): Promise<RoutineVerdict> {
  const standing = { store: deps.grants, activation: deps.activation, now: deps.now };
  for (const { action, resource } of routine.scopes) {
    const answer = await resolveStandingAuthority(standing, {
      grantId: routine.grantId,
      action,
      resource,
    });
    const stop = stopFor(answer, routine);
    if (stop === null) continue;
    if (stop.cancelReason !== null) await cancelRoutineWith(deps, routine, stop.cancelReason);
    return { allow: false, reason: stop.why, cancelled: stop.cancelReason !== null };
  }
  return { allow: true };
}

async function checkState(
  deps: RoutineDeps,
  routine: RoutineRecord,
): Promise<RoutineVerdict | undefined> {
  if (routine.state === 'cancelled') {
    await deps.schedules.revoke(routine.sponsor, routine.routineId);
    return { allow: false, reason: routine.cancelReason ?? 'cancelled', cancelled: true };
  }
  if (!deps.activation.enabled) return { allow: false, reason: 'activation_off', cancelled: false };
  if (Date.parse(routine.expiresAt) > deps.now().getTime()) return undefined;
  await cancelRoutineWith(deps, routine, 'expired');
  return { allow: false, reason: 'expired', cancelled: true };
}

async function cancelRoutineWith(
  deps: RoutineDeps,
  routine: RoutineRecord,
  reason: string,
): Promise<RoutineRecord> {
  const next =
    (await deps.routines.cancel(routine.routineId, reason, deps.now().toISOString())) ?? routine;
  await deps.schedules.revoke(routine.sponsor, routine.routineId);
  return next;
}

function mayCancel(
  actor: GrantActor,
  routine: RoutineRecord,
  grant: StandingGrant | undefined,
): boolean {
  if (actor.kind === 'human') {
    return actor.sub === routine.sponsor || actor.role === 'owner' || actor.role === 'admin';
  }
  return grant?.grantee.botId === actor.botId && grant.grantee.botVersion === actor.botVersion;
}

export function createRoutineService(deps: RoutineDeps) {
  const stamp = (): string => deps.now().toISOString();
  const standing = { store: deps.grants, activation: deps.activation, now: deps.now };

  const cancelRoutine = (routine: RoutineRecord, reason: string) =>
    cancelRoutineWith(deps, routine, reason);

  async function ensureSchedule(spec: ScheduleSpec, routine: RoutineRecord): Promise<void> {
    await deps.schedules.create(spec, routine.sponsor, {
      ref: spec.consentRef,
      digest: routine.digest,
      expiresAt: routine.expiresAt,
    });
  }

  /**
   * The bound check for one occurrence claim or one effect. Because it re-reads the grant chain,
   * a revocation or expiry of the sponsor grant or any ancestor cancels the routine and its
   * queued occurrences. Activation off denies without cancelling, because that is a pause.
   */
  async function authorize(routineId: string): Promise<RoutineVerdict> {
    const routine = await deps.routines.get(routineId);
    if (routine === undefined)
      return { allow: false, reason: 'routine_not_found', cancelled: false };
    return (await checkState(deps, routine)) ?? checkGrant(deps, routine);
  }

  async function persist(
    routine: RoutineRecord,
    spec: ScheduleSpec,
    maxActive: number,
  ): Promise<ProposeResult> {
    const created = await deps.routines.create(routine, maxActive);
    if (created.outcome === 'conflict') return { ok: false, code: 'IDEMPOTENCY_CONFLICT' };
    if (created.outcome === 'fan_out_exceeded') return { ok: false, code: 'FAN_OUT_EXCEEDED' };
    if (created.record.state === 'active') {
      try {
        await ensureSchedule(spec, created.record);
      } catch {
        await cancelRoutine(created.record, 'schedule_rejected');
        return { ok: false, code: 'SCHEDULE_REJECTED' };
      }
    }
    return { ok: true, routine: created.record, replayed: created.outcome === 'existing' };
  }

  return {
    authorize,

    /**
     * An agent proposes a routine. The caller is the running bot as the server established it.
     * Everything else is data: the sponsor, consent reference and schedule id are set by the
     * server, and every limit is checked against the grant by code.
     */
    async propose(actor: GrantActor, input: unknown): Promise<ProposeResult> {
      const intake = await intakeProposal(deps, actor, input);
      if ('code' in intake) return { ok: false, code: intake.code };
      const { proposal, chain, grant } = intake;
      const routineId = routineIdFor(grant.grantId, proposal.idempotencyKey);
      const spec = scheduleSpecSchema.safeParse({
        ...proposal.spec,
        id: routineId,
        consentRef: `grant:${grant.grantId}`,
      });
      if (!spec.success) return { ok: false, code: 'INVALID_PROPOSAL' };
      const digest = scheduleHash(spec.data);
      const prior = await deps.routines.get(routineId);
      if (prior !== undefined) {
        if (prior.digest !== digest) return { ok: false, code: 'IDEMPOTENCY_CONFLICT' };
        if (prior.state === 'active') await ensureSchedule(spec.data, prior);
        return { ok: true, routine: prior, replayed: true };
      }
      const checked = await validateProposal(standing, {
        grant,
        chain,
        spec: spec.data,
        kind: proposal.kind,
      });
      if (typeof checked === 'string') return { ok: false, code: checked };
      return persist(
        {
          routineId,
          grantId: grant.grantId,
          sponsor: grant.sponsor,
          idempotencyKey: proposal.idempotencyKey,
          digest,
          kind: proposal.kind,
          scopes: checked,
          state: 'active',
          cancelReason: null,
          createdAt: stamp(),
          expiresAt: spec.data.expiresAt,
          cancelledAt: null,
        },
        spec.data,
        grant.schedule.maxActiveRoutines,
      );
    },

    /**
     * Stops future occurrences and cancels queued and running ones through the schedule revoke
     * path, which uses the worker's cancel. Repeating it finishes any step a crash left undone.
     */
    async cancel(actor: GrantActor, routineId: string): Promise<CancelResult> {
      const routine = await deps.routines.get(routineId);
      if (routine === undefined) return { ok: false, code: 'NOT_FOUND' };
      const grant = await deps.grants.get(routine.grantId);
      const allowed = mayCancel(actor, routine, grant);
      if (!allowed) return { ok: false, code: 'NOT_AUTHORIZED' };
      return { ok: true, routine: await cancelRoutine(routine, 'cancelled_by_request') };
    },

    /** Cancels every active routine whose grant chain is no longer usable. */
    async sweep(): Promise<readonly string[]> {
      const cancelled: string[] = [];
      for (const routine of await deps.routines.listActive()) {
        const verdict = await authorize(routine.routineId);
        if (!verdict.allow && verdict.cancelled) cancelled.push(routine.routineId);
      }
      return cancelled;
    },

    /**
     * Wraps the scheduler's sponsor-authority resolver. For a routine it adds the grant check, so
     * the scheduler's own tick, claim and post-dispatch rechecks all enforce the binding.
     */
    guardSponsorAuthority(base: AuthorityResolver): AuthorityResolver {
      return async (spec) => {
        const current = await base(spec);
        if ((await deps.routines.get(spec.id)) === undefined) return current;
        const verdict = await authorize(spec.id);
        return verdict.allow ? current : { ...current, active: false };
      };
    },
  };
}
