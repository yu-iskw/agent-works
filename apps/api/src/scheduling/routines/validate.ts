import { resolveStandingAuthority } from '../../authority-lifecycle/resolver.js';

import { MAX_ROUTINE_LIFETIME_SECONDS, minGapSeconds, occurrences } from './occurrences.js';

import type { RoutineKind, RoutineScope } from './types.js';
import type { GrantActivation } from '../../authority-lifecycle/lifecycle.js';
import type { GrantStore } from '../../authority-lifecycle/store.js';
import type { ScheduleSpec } from '@agent-works/domain';
import type { StandingGrant } from '@agent-works/domain/standing-grant-contract';

/** Lowest recurrence the platform allows, whatever the grant says. */
const MIN_ROUTINE_INTERVAL_SECONDS = 60;
const MAX_FIRES = 50_000;

export type RoutineDenial =
  | 'ACTIVATION_OFF'
  | 'NOT_AUTHORIZED'
  | 'INVALID_PROPOSAL'
  | 'GRANT_NOT_FOUND'
  | 'GRANT_UNUSABLE'
  | 'SCHEDULE_NOT_ALLOWED'
  | 'SPONSOR_MISMATCH'
  | 'SCOPE_WIDENED'
  | 'BUDGET_WIDENED'
  | 'LIFETIME_EXCEEDED'
  | 'FREQUENCY_TOO_HIGH'
  | 'KIND_MISMATCH'
  | 'FAN_OUT_EXCEEDED'
  | 'IDEMPOTENCY_CONFLICT'
  | 'SCHEDULE_REJECTED';

type StandingDeps = {
  readonly store: GrantStore;
  readonly activation: GrantActivation;
  readonly now: () => Date;
};

/** Every (scope, source) pair the spec could exercise must be a permission of the grant. */
async function checkScope(
  deps: StandingDeps,
  grant: StandingGrant,
  spec: ScheduleSpec,
): Promise<RoutineDenial | RoutineScope[]> {
  const { scopes, sources } = spec.maxPrivilege;
  if (scopes.length === 0 || sources.length === 0) return 'SCOPE_WIDENED';
  const pairs = scopes.flatMap((action) => sources.map((resource) => ({ action, resource })));
  for (const pair of pairs) {
    const answer = await resolveStandingAuthority(deps, { grantId: grant.grantId, ...pair });
    if (answer.kind === 'denied') {
      return answer.reason === 'no_matching_permission' ? 'SCOPE_WIDENED' : 'GRANT_UNUSABLE';
    }
  }
  return pairs;
}

function checkLifetime(
  grant: StandingGrant,
  chain: readonly StandingGrant[],
  spec: ScheduleSpec,
  now: number,
): RoutineDenial | undefined {
  const lifetime = Math.min(grant.schedule.maxLifetimeSeconds, MAX_ROUTINE_LIFETIME_SECONDS);
  const ceiling = Math.min(now + lifetime * 1000, ...chain.map((l) => Date.parse(l.expiresAt)));
  const end = Date.parse(spec.expiresAt);
  return end <= now || end > ceiling ? 'LIFETIME_EXCEEDED' : undefined;
}

/** Counts real fires, so a DST repeat or gap is measured and not assumed. */
function checkFrequency(
  grant: StandingGrant,
  spec: ScheduleSpec,
  kind: RoutineKind,
  now: number,
): RoutineDenial | undefined {
  const floor = Math.max(MIN_ROUTINE_INTERVAL_SECONDS, grant.schedule.minIntervalSeconds);
  const fires = occurrences(spec, now, Date.parse(spec.expiresAt), MAX_FIRES);
  if (kind === 'one_time') return fires.length === 1 ? undefined : 'KIND_MISMATCH';
  if (fires.length < 2) return 'KIND_MISMATCH';
  const gap = minGapSeconds(fires);
  return gap !== undefined && gap < floor ? 'FREQUENCY_TOO_HIGH' : undefined;
}

/** Deterministic acceptance of a proposal against a usable grant chain. Returns the scope pairs. */
export async function validateProposal(
  deps: StandingDeps,
  input: {
    readonly grant: StandingGrant;
    readonly chain: readonly StandingGrant[];
    readonly spec: ScheduleSpec;
    readonly kind: RoutineKind;
  },
): Promise<RoutineDenial | RoutineScope[]> {
  const { grant, chain, spec, kind } = input;
  if (!grant.schedule.allowed) return 'SCHEDULE_NOT_ALLOWED';
  if (spec.sponsor.sub !== grant.sponsor) return 'SPONSOR_MISMATCH';
  const pairs = await checkScope(deps, grant, spec);
  if (typeof pairs === 'string') return pairs;
  if (spec.maxPrivilege.budgetUsd * 1_000_000 > grant.limits.budget.estimatedCostMicros)
    return 'BUDGET_WIDENED';
  const now = deps.now().getTime();
  return checkLifetime(grant, chain, spec, now) ?? checkFrequency(grant, spec, kind, now) ?? pairs;
}
