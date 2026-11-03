import { InvocationStopped } from '../suspension/enforcement.js';

import { admissionReady } from './migration.js';

import type {
  AdmissionRequest,
  AdmissionResult,
  DenialReason,
  LimitConfig,
  Outcome,
  ReservationState,
  ScopeKind,
} from './types.js';
import type { SuspensionEnforcer } from '../suspension/enforcement.js';
import type postgres from 'postgres';

export type AdmissionService = {
  /** Reserves once per execution id; a replay returns the existing reservation. */
  admit(request: AdmissionRequest): Promise<AdmissionResult>;
  /** Idempotent. Frees concurrency; cost becomes the actual cost, or 0 for a cancel without one. */
  release(
    executionId: string,
    outcome: Outcome,
    actualCostMicros?: number,
  ): Promise<ReservationState>;
  /** Extends a live lease. False means the lease already lapsed and the holder is fenced out. */
  renew(executionId: string): Promise<boolean>;
  /** Reconciler: marks lapsed leases expired and returns their execution ids. */
  sweepExpired(): Promise<readonly string[]>;
  setLimit(kind: ScopeKind, id: string, config: LimitConfig): Promise<void>;
  removeLimit(kind: ScopeKind, id: string): Promise<void>;
  setProviderBucket(provider: string, capacity: number, refillPerSecond: number): Promise<void>;
  inFlight(kind: ScopeKind, id: string): Promise<number>;
};
export type AdmissionOptions = {
  readonly sql: postgres.Sql;
  /** Reservation lease. Owner-set; there is no default. */
  readonly leaseMs: number;
  readonly now?: () => Date;
  readonly suspension?: SuspensionEnforcer;
};
type Tx = postgres.TransactionSql;
type Row = {
  member_id: string;
  bot_id: string;
  segment_id: string;
  state: ReservationState;
  expires_at: Date;
};
type Limit = {
  max_concurrent: number | null;
  max_share_bps: number | null;
  max_cost_micros: string | null;
};
const column: Record<ScopeKind, string> = {
  member: 'member_id',
  bot: 'bot_id',
  segment: 'segment_id',
};
const capReason: Record<ScopeKind, DenialReason> = {
  member: 'member_cap',
  bot: 'bot_cap',
  segment: 'segment_cap',
};

export async function createAdmissionService(options: AdmissionOptions): Promise<AdmissionService> {
  const { sql, leaseMs } = options;
  if (!Number.isSafeInteger(leaseMs) || leaseMs <= 0) throw new Error('admission lease');
  const clock = options.now ?? (() => new Date());
  await admissionReady(sql);

  async function admit(request: AdmissionRequest): Promise<AdmissionResult> {
    validate(request);
    if (options.suspension !== undefined) {
      if (request.invocation === undefined) throw new Error('admission invocation context');
      try {
        await options.suspension.check(request.invocation, 'admission');
      } catch (error) {
        if (error instanceof InvocationStopped) return { admitted: false, reason: 'suspended' };
        throw error;
      }
    }
    const now = clock();
    return sql.begin((tx) => reserve(tx, request, now, new Date(now.getTime() + leaseMs)));
  }
  return {
    admit,
    async release(executionId, outcome, actualCostMicros) {
      if (actualCostMicros !== undefined && !isCost(actualCostMicros))
        throw new Error('admission cost');
      const finished = await sql<{ state: ReservationState }[]>`
        update admission_reservations
        set state = ${outcome}, finished_at = ${clock()},
            cost_micros = coalesce(${actualCostMicros ?? null}::bigint,
              case when ${outcome} = 'cancelled' then 0 else estimated_cost_micros end)
        where execution_id = ${executionId} and state in ('active', 'expired') returning state`;
      if (finished.length > 0) return outcome;
      const rows = await sql<
        { state: ReservationState }[]
      >`select state from admission_reservations where execution_id = ${executionId}`;
      if (rows.length === 0) throw new Error('unknown admission reservation');
      return rows[0].state;
    },
    async renew(executionId) {
      const now = clock();
      const rows = await sql`
        update admission_reservations set expires_at = ${new Date(now.getTime() + leaseMs)}
        where execution_id = ${executionId} and state = 'active' and expires_at > ${now}
        returning 1`;
      return rows.length > 0;
    },
    async sweepExpired() {
      const rows = await sql<{ execution_id: string }[]>`
        update admission_reservations set state = 'expired', finished_at = ${clock()}
        where state = 'active' and expires_at <= ${clock()} returning execution_id`;
      return rows.map((row) => row.execution_id);
    },
    async setLimit(kind, id, config) {
      validateLimit(kind, id, config);
      await sql`
        insert into admission_limits (scope_kind, scope_id, max_concurrent, max_share_bps, max_cost_micros, updated_at)
        values (${kind}, ${id}, ${config.maxConcurrent ?? null}, ${config.maxShareBps ?? null},
                ${config.maxCostMicros ?? null}, ${clock()})
        on conflict (scope_kind, scope_id) do update set max_concurrent = excluded.max_concurrent,
          max_share_bps = excluded.max_share_bps, max_cost_micros = excluded.max_cost_micros,
          updated_at = excluded.updated_at`;
    },
    async removeLimit(kind, id) {
      await sql`delete from admission_limits where scope_kind = ${kind} and scope_id = ${id}`;
    },
    async setProviderBucket(provider, capacity, refillPerSecond) {
      await sql`
        insert into admission_token_buckets (provider, capacity, refill_per_second, tokens, refilled_at)
        values (${provider}, ${capacity}, ${refillPerSecond}, ${capacity}, ${clock()})
        on conflict (provider) do update set capacity = excluded.capacity,
          refill_per_second = excluded.refill_per_second,
          tokens = least(admission_token_buckets.tokens, excluded.capacity)`;
    },
    async inFlight(kind, id) {
      const rows = await sql<{ count: number }[]>`
        select count(*)::int as count from admission_reservations
        where ${sql(column[kind])} = ${id} and state = 'active' and expires_at > ${clock()}`;
      return rows[0].count;
    },
  };
}

async function reserve(
  tx: Tx,
  request: AdmissionRequest,
  now: Date,
  expiresAt: Date,
): Promise<AdmissionResult> {
  const scopes: [ScopeKind, string][] = [
    ['bot', request.botId],
    ['member', request.memberId],
    ['segment', request.segmentId],
  ];
  await lockScopes(tx, scopes);
  const existing = await tx<Row[]>`
    select member_id, bot_id, segment_id, state, expires_at from admission_reservations
    where execution_id = ${request.executionId}`;
  const replay = replayOf(existing.at(0), request, now);
  if (replay !== undefined) return replay;
  for (const [kind, id] of scopes) {
    const denial = await checkScope(tx, kind, id, request, now);
    if (denial !== undefined) return { admitted: false, reason: denial };
  }
  if (request.provider !== undefined) {
    const wait = await takeTokens(tx, request.provider, request.providerTokens ?? 1, now);
    if (wait !== undefined) return { admitted: false, reason: 'provider_throttle', ...wait };
  }
  await tx`
    insert into admission_reservations (execution_id, member_id, bot_id, segment_id, window_key, state,
      estimated_cost_micros, cost_micros, provider, created_at, expires_at)
    values (${request.executionId}, ${request.memberId}, ${request.botId}, ${request.segmentId},
      ${request.windowKey}, 'active', ${request.estimatedCostMicros}, ${request.estimatedCostMicros},
      ${request.provider ?? null}, ${now}, ${expiresAt})
    on conflict (execution_id) do update set state = 'active', expires_at = excluded.expires_at,
      finished_at = null`;
  return { admitted: true, replay: false, expiresAt };
}

/** Fixed (kind, id)-ordered lock acquisition across all callers: no deadlock, and the counts
 * read afterwards cannot change under us. */
async function lockScopes(tx: Tx, scopes: readonly [ScopeKind, string][]): Promise<void> {
  for (const [kind, id] of scopes) {
    await tx`insert into admission_scopes (scope_kind, scope_id) values (${kind}, ${id}) on conflict do nothing`;
  }
  for (const [kind, id] of [...scopes].sort((a, b) => (a[0] + a[1]).localeCompare(b[0] + b[1]))) {
    await tx`select 1 from admission_scopes where scope_kind = ${kind} and scope_id = ${id} for update`;
  }
}

/** A finished or still-leased execution answers from the stored row; an expired one re-admits. */
function replayOf(
  prior: Row | undefined,
  request: AdmissionRequest,
  now: Date,
): AdmissionResult | undefined {
  if (prior === undefined) return undefined;
  if (
    prior.member_id !== request.memberId ||
    prior.bot_id !== request.botId ||
    prior.segment_id !== request.segmentId
  )
    throw new Error('admission execution identity conflict');
  if (prior.state === 'succeeded' || prior.state === 'failed' || prior.state === 'cancelled')
    return { admitted: false, reason: 'already_finished', state: prior.state };
  if (prior.state === 'active' && prior.expires_at > now)
    return { admitted: true, replay: true, expiresAt: prior.expires_at };
  return undefined;
}

async function checkScope(
  tx: Tx,
  kind: ScopeKind,
  id: string,
  request: AdmissionRequest,
  now: Date,
): Promise<DenialReason | undefined> {
  const limits = await tx<Limit[]>`
    select max_concurrent, max_share_bps, max_cost_micros::text from admission_limits
    where scope_kind = ${kind} and scope_id = ${id}`;
  const limit = limits.at(0);
  if (limit === undefined) return undefined;
  return (
    (await concurrencyDenial(tx, [kind, id], limit, request, now)) ??
    (await costDenial(tx, kind, id, limit, request))
  );
}

async function concurrencyDenial(
  tx: Tx,
  [kind, id]: readonly [ScopeKind, string],
  limit: Limit,
  request: AdmissionRequest,
  now: Date,
): Promise<DenialReason | undefined> {
  if (limit.max_concurrent === null) return undefined;
  const self = request.executionId;
  const held = await tx<{ count: number }[]>`
    select count(*)::int as count from admission_reservations
    where ${tx(column[kind])} = ${id} and state = 'active' and expires_at > ${now}
      and execution_id <> ${self}`;
  if (held[0].count >= limit.max_concurrent) return capReason[kind];
  if (limit.max_share_bps === null) return undefined;
  // Fairness: one member holds at most its configured share of the segment, so a noisy member
  // cannot take the slots peers need. The floor of one keeps small segments usable.
  const share = Math.max(1, Math.floor((limit.max_concurrent * limit.max_share_bps) / 10_000));
  const mine = await tx<{ count: number }[]>`
    select count(*)::int as count from admission_reservations
    where member_id = ${request.memberId} and segment_id = ${id} and state = 'active'
      and expires_at > ${now} and execution_id <> ${self}`;
  return mine[0].count >= share ? 'member_share' : undefined;
}

async function costDenial(
  tx: Tx,
  kind: ScopeKind,
  id: string,
  limit: Limit,
  request: AdmissionRequest,
): Promise<DenialReason | undefined> {
  if (limit.max_cost_micros === null) return undefined;
  const spent = await tx<{ total: string }[]>`
    select coalesce(sum(cost_micros), 0)::text as total from admission_reservations
    where ${tx(column[kind])} = ${id} and window_key = ${request.windowKey}
      and execution_id <> ${request.executionId}`;
  const total = BigInt(spent[0].total) + BigInt(request.estimatedCostMicros);
  return total > BigInt(limit.max_cost_micros) ? 'cost_budget' : undefined;
}

/** Takes tokens without ever waiting. A shortfall returns the delay the caller should wait. */
async function takeTokens(
  tx: Tx,
  provider: string,
  wanted: number,
  now: Date,
): Promise<{ retryAfterMs?: number } | undefined> {
  const rows = await tx<
    { capacity: number; refill_per_second: number; tokens: number; refilled_at: Date }[]
  >`
    select capacity, refill_per_second, tokens, refilled_at from admission_token_buckets
    where provider = ${provider} for update`;
  const bucket = rows.at(0);
  if (bucket === undefined) return undefined;
  if (wanted > bucket.capacity) return {};
  const elapsed = Math.max(0, now.getTime() - bucket.refilled_at.getTime()) / 1000;
  const tokens = Math.min(bucket.capacity, bucket.tokens + elapsed * bucket.refill_per_second);
  if (tokens < wanted) {
    return { retryAfterMs: Math.ceil(((wanted - tokens) / bucket.refill_per_second) * 1000) };
  }
  await tx`update admission_token_buckets set tokens = ${tokens - wanted}, refilled_at = ${now}
    where provider = ${provider}`;
  return undefined;
}

function isCost(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0;
}
function validate(request: AdmissionRequest): void {
  const ids = [
    request.executionId,
    request.memberId,
    request.botId,
    request.segmentId,
    request.windowKey,
  ];
  if (ids.some((id) => id === '')) throw new Error('admission request ids');
  if (!isCost(request.estimatedCostMicros)) throw new Error('admission cost');
  const tokens = request.providerTokens ?? 1;
  if (!Number.isSafeInteger(tokens) || tokens <= 0) throw new Error('admission provider tokens');
}
function validateLimit(kind: ScopeKind, id: string, config: LimitConfig): void {
  if (id === '') throw new Error('admission limit scope');
  for (const value of [config.maxConcurrent, config.maxCostMicros]) {
    if (value !== undefined && !isCost(value)) throw new Error('admission limit value');
  }
  if (config.maxShareBps !== undefined) {
    if (kind !== 'segment' || config.maxConcurrent === undefined)
      throw new Error('admission share needs a segment cap');
    if (
      !Number.isSafeInteger(config.maxShareBps) ||
      config.maxShareBps < 1 ||
      config.maxShareBps > 10_000
    )
      throw new Error('admission share bps');
  }
}
