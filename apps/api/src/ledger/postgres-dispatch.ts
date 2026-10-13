import { randomUUID } from 'node:crypto';

import {
  canonicalPayloadSha256,
  deliveryPayload,
  taskStatusSchema,
  terminalStatuses,
} from '@agent-works/domain';

import {
  applyLease,
  claimedFrom,
  createDispatchHarness,
  DispatchInjectedFault,
  leaseConflict,
  parseAccept,
  proofFrom,
  requireAttempt,
  requireInstant,
  requireLeaseMs,
  requireProof,
  submittedEvent,
} from '../ports/dispatch-port.js';
import { acceptedTask, queuedTask, taskMissing } from '../ports/ledger-port.js';

import {
  createPostgresLedgerPort,
  insertTask,
  replayClaim,
  taskLedgerReady,
  writeOutbox,
} from './postgres-ledger.js';

import type {
  AcceptTask,
  DeliveryRow,
  DispatchHarness,
  DispatchPort,
  DispatchSeam,
  LeaseCommand,
} from '../ports/dispatch-port.js';
import type {
  ClaimedDelivery,
  DeliveryPayload,
  LeaseProof,
  TaskAccepted,
  TaskStatus,
} from '@agent-works/domain';
import type postgres from 'postgres';

const ledgerVersion = 'postgres';

type DeliverySql = {
  task_id: string;
  payload: unknown;
  available_at: Date | string;
  attempt: number | string;
  worker_id: string | null;
  lease_until: Date | string | null;
  fencing_token: number | string;
  status: string;
};

type LockedDelivery = {
  readonly row: DeliveryRow;
  readonly status: TaskStatus;
};

export function createPostgresDispatchPort(
  sql: postgres.Sql,
  now: () => Date = () => new Date(),
  seam?: DispatchSeam,
): DispatchPort {
  const ready = taskLedgerReady(sql);
  return {
    accept(input) {
      return ready.then(() => acceptTask(sql, now, seam, input));
    },
    claim(workerId, leaseMs) {
      return ready.then(() => claimTask(sql, now, workerId, leaseMs));
    },
    renew(lease, leaseMs) {
      return ready.then(() => renewTask(sql, now, lease, leaseMs));
    },
    release(lease) {
      return ready.then(() => releaseTask(sql, lease));
    },
    scheduleRetry(lease, at, attempt) {
      return ready.then(() => retryTask(sql, now, lease, at, attempt));
    },
  };
}

export function createPostgresDispatchHarness(sql: postgres.Sql): DispatchHarness {
  return createDispatchHarness(
    (now, seam) => ({
      dispatch: createPostgresDispatchPort(sql, now, seam),
      ledger: createPostgresLedgerPort(sql, now),
    }),
    () => countRows(sql),
  );
}

async function acceptTask(
  sql: postgres.Sql,
  now: () => Date,
  seam: DispatchSeam | undefined,
  input: AcceptTask,
): Promise<TaskAccepted> {
  const parsed = parseAccept(input);
  const taskId = randomUUID();
  const at = new Date(now().getTime());
  return sql.begin(async (tx) => {
    const claimed = await tx<{ task_id: string }[]>`
      insert into task_claims (subject, idempotency_key, body_digest, task_id)
      values (${parsed.subject}, ${parsed.idempotencyKey}, ${parsed.digest}, ${taskId})
      on conflict (subject, idempotency_key) do nothing
      returning task_id
    `;
    if (claimed.length === 0) {
      return replayClaim(tx, parsed.subject, parsed.idempotencyKey, parsed.digest);
    }
    const task = queuedTask(
      taskId,
      parsed.subject,
      parsed.request,
      at.toISOString(),
      ledgerVersion,
    );
    await insertTask(tx, task);
    if (seam?.failAfterTaskInsert) {
      seam.failAfterTaskInsert = false;
      throw new DispatchInjectedFault();
    }
    const event = submittedEvent(parsed, task);
    await writeOutbox(tx, event, canonicalPayloadSha256(event));
    await insertDelivery(tx, task.id, parsed.payload, at);
    return acceptedTask(task);
  });
}

async function claimTask(
  sql: postgres.Sql,
  now: () => Date,
  workerId: string,
  leaseMs: number,
): Promise<ClaimedDelivery | undefined> {
  requireLeaseMs(leaseMs);
  return sql.begin((tx) => scanClaim(tx, now, workerId, leaseMs));
}

async function scanClaim(
  tx: postgres.TransactionSql,
  now: () => Date,
  workerId: string,
  leaseMs: number,
): Promise<ClaimedDelivery | undefined> {
  const skipped: string[] = [];
  for (;;) {
    const locked = await lockRunnable(tx, new Date(now().getTime()), skipped);
    if (locked === undefined) return undefined;
    const decision = applyLease(
      locked.row,
      locked.status,
      { kind: 'claim', workerId, leaseMs },
      new Date(now().getTime()),
    );
    if (decision.kind === 'ok') {
      await saveDelivery(tx, decision.row);
      return claimedFrom(decision.row);
    }
    if (decision.kind === 'conflict') throw leaseConflict();
    skipped.push(locked.row.taskId);
  }
}

async function renewTask(
  sql: postgres.Sql,
  now: () => Date,
  lease: LeaseProof,
  leaseMs: number,
): Promise<ClaimedDelivery> {
  requireLeaseMs(leaseMs);
  const proof = requireProof(lease);
  const row = await mutateLease(sql, proof.taskId, { kind: 'renew', lease: proof, leaseMs }, () => {
    return new Date(now().getTime());
  });
  return claimedFrom(row);
}

async function releaseTask(sql: postgres.Sql, lease: LeaseProof): Promise<LeaseProof> {
  const proof = requireProof(lease);
  const row = await mutateLease(sql, proof.taskId, { kind: 'release', lease: proof }, (locked) => {
    return locked.availableAt;
  });
  return proofFrom(row, proof.workerId);
}

async function retryTask(
  sql: postgres.Sql,
  now: () => Date,
  lease: LeaseProof,
  at: string,
  attempt: number,
): Promise<LeaseProof> {
  requireAttempt(attempt);
  requireInstant(at);
  const proof = requireProof(lease);
  const row = await mutateLease(
    sql,
    proof.taskId,
    { kind: 'scheduleRetry', lease: proof, at, attempt },
    () => new Date(now().getTime()),
  );
  return proofFrom(row, proof.workerId);
}

async function mutateLease(
  sql: postgres.Sql,
  taskId: string,
  command: LeaseCommand,
  at: (row: DeliveryRow) => Date,
): Promise<DeliveryRow> {
  return sql.begin(async (tx) => {
    const locked = await lockDelivery(tx, taskId);
    const decision = applyLease(locked.row, locked.status, command, at(locked.row));
    if (decision.kind !== 'ok') throw leaseConflict();
    await saveDelivery(tx, decision.row);
    return decision.row;
  });
}

async function countRows(sql: postgres.Sql): Promise<{
  tasks: number;
  outbox: number;
  deliveries: number;
}> {
  const rows = await sql<{ tasks: number; outbox: number; deliveries: number }[]>`
    select
      (select count(*)::int from tasks) as tasks,
      (select count(*)::int from outbox_events) as outbox,
      (select count(*)::int from task_deliveries) as deliveries
  `;
  const row = rows.at(0);
  if (row === undefined) throw taskMissing();
  return { tasks: row.tasks, outbox: row.outbox, deliveries: row.deliveries };
}

async function insertDelivery(
  tx: postgres.TransactionSql,
  taskId: string,
  payload: DeliveryPayload,
  at: Date,
): Promise<void> {
  await tx`
    insert into task_deliveries (task_id, payload, available_at, attempt, fencing_token)
    values (${taskId}, ${tx.json(payload)}, ${at}, ${0}, ${0})
  `;
}

async function lockRunnable(
  tx: postgres.TransactionSql,
  at: Date,
  skipped: readonly string[],
): Promise<LockedDelivery | undefined> {
  const rows = await tx<DeliverySql[]>`
    select d.task_id, d.payload, d.available_at, d.attempt, d.worker_id, d.lease_until,
           d.fencing_token, t.status
    from task_deliveries d
    join tasks t on t.id = d.task_id
    where d.available_at <= ${at}
      and (d.lease_until is null or d.lease_until <= ${at})
      and t.status <> 'BLOCKED_AUTH'
      and t.status <> all(${pgTextArray(terminalStatuses)}::text[])
      and d.task_id <> all(${pgTextArray(skipped)}::text[])
    order by d.available_at, d.task_id
    limit 1
    for update of d skip locked
  `;
  if (rows.length === 0) return undefined;
  const locked = lockedFrom(rows[0]);
  const tasks = await tx<
    { status: string }[]
  >`select status from tasks where id = ${locked.row.taskId} for update`;
  return { row: locked.row, status: taskStatusSchema.parse(tasks[0].status) };
}

async function lockDelivery(tx: postgres.TransactionSql, taskId: string): Promise<LockedDelivery> {
  const rows = await tx<DeliverySql[]>`
    select d.task_id, d.payload, d.available_at, d.attempt, d.worker_id, d.lease_until,
           d.fencing_token, t.status
    from task_deliveries d
    join tasks t on t.id = d.task_id
    where d.task_id = ${taskId}
    for update of d
  `;
  if (rows.length === 0) throw taskMissing();
  const locked = lockedFrom(rows[0]);
  const tasks = await tx<
    { status: string }[]
  >`select status from tasks where id = ${locked.row.taskId} for update`;
  return { row: locked.row, status: taskStatusSchema.parse(tasks[0].status) };
}

function lockedFrom(row: DeliverySql): LockedDelivery {
  return { row: toDeliveryRow(row), status: taskStatusSchema.parse(row.status) };
}

async function saveDelivery(tx: postgres.TransactionSql, row: DeliveryRow): Promise<void> {
  await tx`
    update task_deliveries
    set payload = ${tx.json(row.payload)},
        available_at = ${row.availableAt},
        attempt = ${row.attempt},
        worker_id = ${row.workerId ?? null},
        lease_until = ${row.leaseUntil ?? null},
        fencing_token = ${row.fencingToken}
    where task_id = ${row.taskId}
  `;
}

function toDeliveryRow(row: DeliverySql): DeliveryRow {
  return {
    taskId: row.task_id,
    payload: deliveryPayload(row.payload),
    availableAt: asDate(row.available_at),
    attempt: asInt(row.attempt),
    workerId: row.worker_id ?? undefined,
    leaseUntil: row.lease_until === null ? undefined : asDate(row.lease_until),
    fencingToken: asInt(row.fencing_token),
  };
}

function asDate(value: Date | string): Date {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) throw new RangeError('at');
  return date;
}

function pgTextArray(values: readonly string[]): string {
  return `{${values.map(pgText).join(',')}}`;
}

function pgText(value: string): string {
  return `"${value.replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"`;
}

function asInt(value: number | string): number {
  const parsed = typeof value === 'number' ? value : Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) throw new RangeError('integer');
  return parsed;
}
