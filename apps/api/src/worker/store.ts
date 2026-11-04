import { backoffSeconds } from '../queue/cloud-tasks-config.js';

import { workerReady } from './migration.js';
import { isTerminal, sanitizeErrorClass } from './types.js';

import type { Claim, ExecutionState, FailureClass, WorkerBudget } from './types.js';
import type { Tx } from '../ports/schedule-row-claim-store.js';
import type postgres from 'postgres';

export type HandoffResult = 'accepted' | 'already-terminal' | 'in-progress' | 'unknown-execution';
export type FenceResult = 'committed' | 'stale';
export type FailResult =
  { readonly committed: true; readonly state: ExecutionState } | { readonly committed: false };

export const addMs = (iso: string, ms: number): string =>
  new Date(Date.parse(iso) + ms).toISOString();

async function ensureRow(
  tx: Tx,
  executionId: string,
  now: string,
  budget: WorkerBudget,
): Promise<void> {
  await tx`insert into worker_executions(execution_id, state, max_attempts, next_attempt_at, deadline_at, created_at, updated_at)
    values(${executionId}, 'queued', ${budget.retry.maxAttempts}, ${now},
      ${addMs(now, budget.retry.maxRetryDurationSeconds * 1000)}, ${now}, ${now})
    on conflict(execution_id) do nothing`;
}

const ALREADY_TERMINAL = 'already-terminal' as const;
const runTerminal = ['denied', 'cancelled', 'completed'];

/**
 * Durable handoff. The database decides: the execution must exist as a schedule run, and the
 * queue message only creates or finds the work row. No lease is taken here; a runner claims it,
 * so acknowledging the message never depends on the work finishing.
 */
export async function handoff(
  sql: postgres.Sql,
  input: { executionId: string; now: string; budget: WorkerBudget },
): Promise<HandoffResult> {
  await workerReady(sql);
  const { executionId, now, budget } = input;
  return sql.begin(async (tx) => {
    const runs = await tx<
      { status: string }[]
    >`select status from schedule_runs where id = ${executionId}`;
    if (runs.length === 0) return 'unknown-execution';
    if (runTerminal.includes(runs[0].status)) return ALREADY_TERMINAL;
    await ensureRow(tx, executionId, now, budget);
    const [row] = await tx<
      { state: ExecutionState; live: boolean }[]
    >`select state, coalesce(lease_until > ${now}, false) as live from worker_executions where execution_id = ${executionId}`;
    if (isTerminal(row.state) || row.state === 'quarantined') return ALREADY_TERMINAL;
    return row.state === 'running' && row.live ? 'in-progress' : 'accepted';
  });
}

export async function recordRejected(
  sql: postgres.Sql,
  input: { reason: string; callerSub: string },
): Promise<void> {
  await workerReady(sql);
  await sql`insert into delivery_rejections(reason, caller_sub) values(${sanitizeErrorClass(input.reason)}, ${input.callerSub})`;
}

/** Leases the next due execution and bumps its fence. Attempts count claims, so a dying worker still spends budget. */
export async function claimNext(
  sql: postgres.Sql,
  input: { now: string; owner: string; budget: WorkerBudget },
): Promise<Claim | undefined> {
  await workerReady(sql);
  const { now, owner, budget } = input;
  return sql.begin(async (tx) => {
    const rows = await tx<
      {
        execution_id: string;
        fence: number;
        attempts: number;
        checkpoint_version: number;
        checkpoint_ref: string | null;
      }[]
    >`with next as (
        select execution_id from worker_executions
        where state = 'queued' and next_attempt_at <= ${now} and deadline_at > ${now} and attempts < max_attempts
        order by next_attempt_at, execution_id limit 1 for update skip locked)
      update worker_executions w set state = 'running', fence = w.fence + 1, attempts = w.attempts + 1,
        lease_owner = ${owner}, lease_until = ${now}::timestamptz + ${budget.leaseMs} * interval '1 millisecond',
        updated_at = ${now}
      from next where w.execution_id = next.execution_id
      returning w.execution_id, w.fence::int as fence, w.attempts, w.checkpoint_version, w.checkpoint_ref`;
    if (rows.length === 0) return undefined;
    const row = rows[0];
    await tx`insert into execution_attempts(execution_id, attempt, fence, owner, started_at)
      values(${row.execution_id}, ${row.attempts}, ${row.fence}, ${owner}, ${now})`;
    return {
      executionId: row.execution_id,
      fence: row.fence,
      attempt: row.attempts,
      owner,
      checkpointVersion: row.checkpoint_version,
      checkpointRef: row.checkpoint_ref,
    };
  });
}

type Held = { attempts: number; max_attempts: number; deadline_at: Date };

/** The fence compare-and-swap. Every commit goes through here and locks the row it just verified. */
async function lockHeld(tx: Tx, claim: Claim): Promise<Held | undefined> {
  const rows = await tx<Held[]>`select attempts, max_attempts, deadline_at from worker_executions
    where execution_id = ${claim.executionId} and fence = ${claim.fence} and state = 'running' for update`;
  return rows[0];
}

export async function renewLease(
  sql: postgres.Sql,
  claim: Claim,
  input: { now: string; budget: WorkerBudget },
): Promise<FenceResult> {
  const res = await sql`update worker_executions set
      lease_until = ${input.now}::timestamptz + ${input.budget.leaseMs} * interval '1 millisecond', updated_at = ${input.now}
    where execution_id = ${claim.executionId} and fence = ${claim.fence} and state = 'running'`;
  return res.count === 1 ? 'committed' : 'stale';
}

/** Checkpoints advance by exactly one version, fenced. A stale worker never moves the cursor. */
export async function commitCheckpoint(
  sql: postgres.Sql,
  claim: Claim,
  input: { version: number; ref: string; now: string },
): Promise<FenceResult> {
  const res = await sql`update worker_executions set checkpoint_version = ${input.version},
      checkpoint_ref = ${input.ref}, updated_at = ${input.now}
    where execution_id = ${claim.executionId} and fence = ${claim.fence} and state = 'running'
      and checkpoint_version = ${input.version - 1}`;
  return res.count === 1 ? 'committed' : 'stale';
}

async function closeAttempt(
  tx: Tx,
  claim: Claim,
  outcome: string,
  errorClass: string | null,
  now: string,
): Promise<void> {
  await tx`update execution_attempts set ended_at = ${now}, outcome = ${outcome}, error_class = ${errorClass}
    where execution_id = ${claim.executionId} and attempt = ${claim.attempt} and ended_at is null`;
}

export async function completeExecution(
  sql: postgres.Sql,
  claim: Claim,
  input: { resultDigest: string; now: string },
): Promise<FenceResult> {
  return sql.begin(async (tx) => {
    if ((await lockHeld(tx, claim)) === undefined) return 'stale';
    await tx`update worker_executions set state = 'succeeded', result_digest = ${input.resultDigest},
        lease_owner = null, lease_until = null, last_error_class = null, updated_at = ${input.now}
      where execution_id = ${claim.executionId}`;
    await closeAttempt(tx, claim, 'succeeded', null, input.now);
    return 'committed';
  });
}

/**
 * Records a classified attempt failure and decides the next state in one fenced transaction.
 * permanent and denied are terminal (the transport stops looping on already-terminal), uncertain
 * parks for reconciliation, and retryable backs off until an attempt or time budget runs out,
 * then quarantines visibly.
 */
export async function failExecution(
  sql: postgres.Sql,
  claim: Claim,
  input: {
    failureClass: FailureClass;
    errorClass: string;
    now: string;
    budget: WorkerBudget;
  },
): Promise<FailResult> {
  const { failureClass, now, budget } = input;
  const errorClass = sanitizeErrorClass(input.errorClass);
  return sql.begin(async (tx) => {
    const held = await lockHeld(tx, claim);
    if (held === undefined) return { committed: false } as const;
    let state: ExecutionState;
    let reason: string | null = null;
    let nextAt = now;
    if (failureClass === 'permanent') state = 'failed';
    else if (failureClass === 'denied') state = 'denied';
    else if (failureClass === 'uncertain') state = 'awaiting-reconciliation';
    else {
      nextAt = addMs(now, backoffSeconds(budget.retry, held.attempts, budget.random) * 1000);
      if (held.attempts >= held.max_attempts) {
        state = 'quarantined';
        reason = 'retry-exhausted';
      } else if (Date.parse(nextAt) >= held.deadline_at.getTime()) {
        state = 'quarantined';
        reason = 'time-budget';
      } else state = 'queued';
    }
    await tx`update worker_executions set state = ${state}, lease_owner = null, lease_until = null,
        next_attempt_at = ${nextAt}, last_error_class = ${errorClass}, quarantine_reason = ${reason}, updated_at = ${now}
      where execution_id = ${claim.executionId}`;
    await closeAttempt(tx, claim, failureClass, errorClass, now);
    return { committed: true, state } as const;
  });
}

/**
 * Revocation, pause or operator cancel. Not fenced on purpose: it must win against a live worker,
 * whose next fenced commit then fails because the row is no longer running.
 */
export async function cancelExecution(
  sql: postgres.Sql,
  input: { executionId: string; now: string; budget: WorkerBudget },
): Promise<'cancelled' | 'already-terminal' | 'unknown-execution'> {
  await workerReady(sql);
  const { executionId, now, budget } = input;
  return sql.begin(async (tx) => {
    const runs = await tx<{ id: string }[]>`select id from schedule_runs where id = ${executionId}`;
    if (runs.length === 0) return 'unknown-execution';
    await ensureRow(tx, executionId, now, budget);
    const [row] = await tx<
      { state: ExecutionState; attempts: number }[]
    >`select state, attempts from worker_executions where execution_id = ${executionId} for update`;
    if (isTerminal(row.state)) return ALREADY_TERMINAL;
    await tx`update worker_executions set state = 'cancelled', lease_owner = null, lease_until = null,
        quarantine_reason = null, updated_at = ${now}
      where execution_id = ${executionId}`;
    await tx`update execution_attempts set ended_at = ${now}, outcome = 'cancelled'
      where execution_id = ${executionId} and ended_at is null`;
    return 'cancelled';
  });
}

export type ExecutionStats = {
  readonly queued: number;
  readonly running: number;
  readonly awaitingReconciliation: number;
  readonly quarantined: number;
  readonly uncertainEffects: number;
  readonly oldestQueuedMs: number;
};

export async function workerStats(sql: postgres.Sql, now: string): Promise<ExecutionStats> {
  await workerReady(sql);
  const [row] = await sql<
    {
      queued: number;
      running: number;
      awaiting: number;
      quarantined: number;
      uncertain: number;
      oldest: number | null;
    }[]
  >`select (select count(*) from worker_executions where state = 'queued')::int as queued,
      (select count(*) from worker_executions where state = 'running')::int as running,
      (select count(*) from worker_executions where state = 'awaiting-reconciliation')::int as awaiting,
      (select count(*) from worker_executions where state = 'quarantined')::int as quarantined,
      (select count(*) from execution_effects where state = 'uncertain')::int as uncertain,
      (select extract(epoch from (${now}::timestamptz - min(next_attempt_at))) * 1000
         from worker_executions where state = 'queued')::float8 as oldest`;
  return {
    queued: row.queued,
    running: row.running,
    awaitingReconciliation: row.awaiting,
    quarantined: row.quarantined,
    uncertainEffects: row.uncertain,
    oldestQueuedMs: Math.max(0, row.oldest ?? 0),
  };
}
