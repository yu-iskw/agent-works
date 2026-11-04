import {
  dispatchEnvelopeV1Schema,
  dispatchTransportName,
  outboxRecordSchema,
} from '@agent-works/domain';

import type { Tx } from '../ports/schedule-row-claim-store.js';
import type { DispatchEnvelopeV1, OutboxRecord, ScheduleRun } from '@agent-works/domain';
import type postgres from 'postgres';

/** Stable per occurrence, so a repeated insert is a no-op and a publish retry never mints a new id. */
export const dispatchIdFor = (executionId: string): string => `dsp:${executionId}`;

/** What a publisher holds after claiming. `fence` is the compare-and-swap token for completion. */
export type OutboxLease = {
  readonly dispatchId: string;
  readonly transportName: string;
  readonly envelope: DispatchEnvelopeV1;
  readonly fence: number;
  readonly attempts: number;
  readonly owner: string;
};

export type ClaimBatchInput = {
  now: string;
  limit: number;
  owner: string;
  leaseMs: number;
  maxAttempts: number;
};
export type FailureInput = {
  now: string;
  errorClass: string;
  retryable: boolean;
  retryAt: string;
  maxAttempts: number;
};
export type FailureResult = 'retry' | 'abandoned' | 'superseded';
export type OutboxStats = {
  pending: number;
  published: number;
  abandoned: number;
  oldestPendingMs: number;
};

/** The claim-transaction write. Validates the contract record before it touches the table. */
export async function insertOutbox(tx: Tx, run: ScheduleRun, now: string): Promise<void> {
  const dispatchId = dispatchIdFor(run.id);
  const record = outboxRecordSchema.parse({
    dispatchId,
    executionId: run.id,
    targetKind: 'cloud-tasks-http',
    transportName: dispatchTransportName(dispatchId),
    envelope: { schemaVersion: 1, executionId: run.id, dispatchId },
    state: 'pending',
    attempts: 0,
    nextAttemptAt: now,
    leaseOwner: null,
    leaseUntil: null,
    lastErrorClass: null,
    createdAt: now,
    publishedAt: null,
  } satisfies OutboxRecord);

  await tx`insert into dispatch_outbox(dispatch_id, execution_id, target_kind, transport_name, envelope, state, attempts, next_attempt_at, created_at)
    values(${record.dispatchId}, ${record.executionId}, ${record.targetKind}, ${record.transportName}, ${tx.json(record.envelope)}, 'pending', 0, ${record.nextAttemptAt}, ${record.createdAt})
    on conflict(dispatch_id) do nothing`;
}

type LeaseRow = {
  dispatch_id: string;
  transport_name: string;
  envelope: unknown;
  fence: number;
  attempts: number;
};

/**
 * Leases a batch with FOR UPDATE SKIP LOCKED in one short statement. A lease whose expiry has
 * passed is claimable again, which is the stale-publisher recovery path. attempts counts claims,
 * so a publisher that dies mid-publish still advances a poison event toward quarantine.
 */
export async function claimBatch(
  sql: postgres.Sql,
  input: ClaimBatchInput,
): Promise<OutboxLease[]> {
  const rows = await sql<LeaseRow[]>`with due as (
      select dispatch_id from dispatch_outbox
      where state = 'pending' and next_attempt_at <= ${input.now}
        and (lease_until is null or lease_until <= ${input.now})
        and attempts < ${input.maxAttempts}
      order by next_attempt_at, dispatch_id limit ${input.limit}
      for update skip locked)
    update dispatch_outbox o set lease_owner = ${input.owner},
      lease_until = ${input.now}::timestamptz + ${input.leaseMs} * interval '1 millisecond',
      fence = o.fence + 1, attempts = o.attempts + 1
    from due where o.dispatch_id = due.dispatch_id
    returning o.dispatch_id, o.transport_name, o.envelope, o.fence::int as fence, o.attempts`;
  return rows.map((r) => ({
    dispatchId: r.dispatch_id,
    transportName: r.transport_name,
    envelope: dispatchEnvelopeV1Schema.parse(r.envelope),
    fence: r.fence,
    attempts: r.attempts,
    owner: input.owner,
  }));
}

/** CAS: only the holder of the current fence on a still-pending row can publish it. */
export async function markPublished(
  sql: postgres.Sql,
  lease: OutboxLease,
  now: string,
): Promise<boolean> {
  const res = await sql`update dispatch_outbox set state = 'published', published_at = ${now},
      lease_owner = null, lease_until = null, last_error_class = null
    where dispatch_id = ${lease.dispatchId} and fence = ${lease.fence} and state = 'pending'`;
  return res.count === 1;
}

export async function markFailed(
  sql: postgres.Sql,
  lease: OutboxLease,
  input: FailureInput,
): Promise<FailureResult> {
  const abandon = !input.retryable || lease.attempts >= input.maxAttempts;
  const res = await sql`update dispatch_outbox set state = ${abandon ? 'abandoned' : 'pending'},
      lease_owner = null, lease_until = null, next_attempt_at = ${input.retryAt},
      last_error_class = ${input.errorClass}
    where dispatch_id = ${lease.dispatchId} and fence = ${lease.fence} and state = 'pending'`;
  if (res.count !== 1) return 'superseded';
  return abandon ? 'abandoned' : 'retry';
}

/**
 * Clears leases that expired without a result so they show as `lease-expired`, and quarantines
 * events that have used every attempt. Terminal rows are never touched.
 */
export async function reconcileLeases(
  sql: postgres.Sql,
  input: { now: string; maxAttempts: number },
): Promise<{ released: number; abandoned: number }> {
  const rows = await sql<{ state: string }[]>`update dispatch_outbox set lease_owner = null,
      lease_until = null, last_error_class = 'lease-expired',
      state = case when attempts >= ${input.maxAttempts} then 'abandoned' else 'pending' end
    where state = 'pending' and lease_until <= ${input.now} returning state`;
  const abandoned = rows.filter((r) => r.state === 'abandoned').length;
  return { released: rows.length - abandoned, abandoned };
}

export async function outboxStats(sql: postgres.Sql, now: string): Promise<OutboxStats> {
  const [row] = await sql<
    { pending: number; published: number; abandoned: number; oldest: number | null }[]
  >`select count(*) filter (where state = 'pending')::int as pending,
      count(*) filter (where state = 'published')::int as published,
      count(*) filter (where state = 'abandoned')::int as abandoned,
      (extract(epoch from (${now}::timestamptz - min(created_at) filter (where state = 'pending'))) * 1000)::float8 as oldest
    from dispatch_outbox`;
  return {
    pending: row.pending,
    published: row.published,
    abandoned: row.abandoned,
    oldestPendingMs: row.oldest ?? 0,
  };
}
