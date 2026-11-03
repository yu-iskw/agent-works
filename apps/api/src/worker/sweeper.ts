import { dispatchTransportName, outboxRecordSchema } from '@agent-works/domain';

import { dispatchIdFor } from '../outbox/store.js';
import { backoffSeconds } from '../queue/cloud-tasks-config.js';

import { workerReady } from './migration.js';
import { addMs } from './store.js';

import type { WorkerBudget } from './types.js';
import type { Tx } from '../ports/schedule-row-claim-store.js';
import type { OutboxRecord } from '@agent-works/domain';
import type postgres from 'postgres';

export type SweepOptions = {
  readonly now: string;
  readonly budget: WorkerBudget;
  /** A published dispatch with no work row after this long is presumed lost from the queue. */
  readonly redriveAfterMs: number;
  /** Replay dispatches allowed per execution before it is quarantined as `redrive-exhausted`. */
  readonly maxRedrives: number;
  readonly limit: number;
};

export type SweepReport = {
  readonly requeued: number;
  readonly awaitingReconciliation: number;
  readonly quarantined: number;
  readonly redriven: number;
};

type Expired = { execution_id: string; attempts: number; max_attempts: number; deadline_at: Date };

/**
 * Recovers work from the database alone, so queue loss, worker death and lost leases need no
 * message. Leases that expired are released (any in-flight effect becomes uncertain, never
 * replayed), exhausted or over-budget work is quarantined with a visible reason, and executions
 * whose published dispatch never produced a work row get a new outbox row.
 */
export async function sweep(sql: postgres.Sql, options: SweepOptions): Promise<SweepReport> {
  await workerReady(sql);
  const report = { requeued: 0, awaitingReconciliation: 0, quarantined: 0, redriven: 0 };
  const { now } = options;
  await sql.begin(async (tx) => {
    const expired = await tx<Expired[]>`select execution_id, attempts, max_attempts, deadline_at
      from worker_executions where state = 'running' and lease_until <= ${now}
      order by execution_id limit ${options.limit} for update skip locked`;
    for (const row of expired) {
      const state = await release(tx, row, options);
      if (state === 'queued') report.requeued += 1;
      else if (state === 'quarantined') report.quarantined += 1;
      else report.awaitingReconciliation += 1;
    }
    const over = await tx`update worker_executions set state = 'quarantined',
        quarantine_reason = case when deadline_at <= ${now} then 'time-budget' else 'retry-exhausted' end, updated_at = ${now}
      where state = 'queued' and (deadline_at <= ${now} or attempts >= max_attempts)`;
    report.quarantined += over.count;
    report.redriven = await redrive(tx, options);
  });
  return report;
}

type Released = 'queued' | 'awaiting-reconciliation' | 'quarantined';

/** Ends an expired lease: closes its attempt, voids in-flight effects as uncertain, and picks the next state. */
async function release(tx: Tx, row: Expired, options: SweepOptions): Promise<Released> {
  const { now, budget } = options;
  await tx`update execution_attempts set ended_at = ${now}, outcome = 'lease-expired', error_class = 'lease-expired'
    where execution_id = ${row.execution_id} and attempt = ${row.attempts} and ended_at is null`;
  await tx`update execution_effects set state = 'uncertain', updated_at = ${now}
    where execution_id = ${row.execution_id} and state = 'pending'`;
  const [stuck] = await tx<
    { n: number }[]
  >`select count(*)::int as n from execution_effects where execution_id = ${row.execution_id} and state = 'uncertain'`;
  const nextAt = addMs(now, backoffSeconds(budget.retry, row.attempts, budget.random) * 1000);
  const exhausted = row.attempts >= row.max_attempts;
  const late = Date.parse(nextAt) >= row.deadline_at.getTime();
  let state: Released = 'queued';
  if (stuck.n > 0) state = 'awaiting-reconciliation';
  else if (exhausted || late) state = 'quarantined';
  const reason = state === 'quarantined' ? (exhausted ? 'retry-exhausted' : 'time-budget') : null;
  await tx`update worker_executions set state = ${state}, lease_owner = null, lease_until = null,
      next_attempt_at = ${nextAt}, last_error_class = 'lease-expired', quarantine_reason = ${reason}, updated_at = ${now}
    where execution_id = ${row.execution_id}`;
  return state;
}

async function redrive(tx: Tx, options: SweepOptions): Promise<number> {
  const { now, budget } = options;
  const lost = await tx<{ execution_id: string; n: number }[]>`select r.id as execution_id,
      (select count(*) from dispatch_outbox d where d.execution_id = r.id)::int as n
    from schedule_runs r
    where r.status not in ('denied','cancelled','completed')
      and not exists (select 1 from worker_executions w where w.execution_id = r.id)
      and not exists (select 1 from dispatch_outbox p where p.execution_id = r.id and p.state = 'pending')
      and (select max(p.published_at) from dispatch_outbox p where p.execution_id = r.id and p.state = 'published')
        <= ${addMs(now, -options.redriveAfterMs)}
    order by r.id limit ${options.limit}`;
  let redriven = 0;
  for (const row of lost) {
    if (row.n - 1 >= options.maxRedrives) {
      await tx`insert into worker_executions(execution_id, state, max_attempts, next_attempt_at, deadline_at, quarantine_reason, created_at, updated_at)
        values(${row.execution_id}, 'quarantined', ${budget.retry.maxAttempts}, ${now}, ${now}, 'redrive-exhausted', ${now}, ${now})
        on conflict(execution_id) do nothing`;
      continue;
    }
    const dispatchId = `${dispatchIdFor(row.execution_id)}:r${row.n}`;
    const record = outboxRecordSchema.parse({
      dispatchId,
      executionId: row.execution_id,
      targetKind: 'cloud-tasks-http',
      transportName: dispatchTransportName(dispatchId),
      envelope: { schemaVersion: 1, executionId: row.execution_id, dispatchId },
      state: 'pending',
      attempts: 0,
      nextAttemptAt: now,
      leaseOwner: null,
      leaseUntil: null,
      lastErrorClass: null,
      createdAt: now,
      publishedAt: null,
    } satisfies OutboxRecord);
    const res =
      await tx`insert into dispatch_outbox(dispatch_id, execution_id, target_kind, transport_name, envelope, state, attempts, next_attempt_at, created_at)
      values(${record.dispatchId}, ${record.executionId}, ${record.targetKind}, ${record.transportName}, ${tx.json(record.envelope)}, 'pending', 0, ${record.nextAttemptAt}, ${record.createdAt})
      on conflict do nothing`;
    redriven += res.count;
  }
  return redriven;
}
