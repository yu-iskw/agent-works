import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  canonicalPayloadSha256,
  taskAcceptedSchema,
  taskSchema,
  transition,
} from '@agent-works/domain';

import { LedgerConflict } from '../ports/ledger-port.js';

import type { LedgerPort } from '../ports/ledger-port.js';
import type { OutboxEvent, Task, TaskAccepted, TaskStatus, TaskSubmit } from '@agent-works/domain';
import type postgres from 'postgres';

const migrationName = '0006_tasks.sql';
const migrationLock = 7006;
const migrationPath = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '../../migrations/0006_tasks.sql',
);
const ledgerVersion = 'postgres';
const changedBody = 'task body changed';
const changedEvent = 'outbox event changed';
const missingTask = 'task not found';

const migrations = new WeakMap<postgres.Sql, Promise<void>>();

export class ConcurrentUpdate extends Error {
  constructor() {
    super('stale version');
    this.name = 'ConcurrentUpdate';
  }
}

type TransitionInput = {
  readonly subject: string;
  readonly taskId: string;
  readonly expectedVersion: number;
  readonly to: TaskStatus;
  readonly event: OutboxEvent;
};

export interface TaskLedger extends LedgerPort {
  transition(input: TransitionInput): Promise<Task>;
}

type TaskRow = {
  id: string;
  created_by_sub: string;
  status: string;
  objective_digest: string;
  skill_version: string;
  agent_version: string;
  policy_version: string;
  budget: string | number;
  version: number;
  created_at: Date;
  updated_at: Date;
};

type ClaimRow = {
  body_digest: string;
  task_id: string;
};

type Query = postgres.Sql | postgres.TransactionSql;

export function createPostgresLedgerPort(
  sql: postgres.Sql,
  now: () => Date = () => new Date(),
): TaskLedger {
  const ready = ensureMigration(sql);
  return {
    submit(subject, request, idempotencyKey) {
      return ready.then(() => submitTask(sql, now, subject, request, idempotencyKey));
    },
    read(subject, taskId) {
      return ready.then(() => selectTask(sql, taskId, subject));
    },
    append(event) {
      return ready.then(() => appendEvent(sql, event));
    },
    transition(input) {
      return ready.then(() => commitTransition(sql, now, input));
    },
  };
}

export async function applyTaskLedgerMigration(sql: postgres.Sql): Promise<void> {
  const body = readFileSync(migrationPath, 'utf8');
  await sql.begin(async (tx) => {
    await tx`select pg_advisory_xact_lock(${migrationLock})`;
    await tx`create table if not exists schema_migrations (
      name text primary key,
      applied_at timestamptz not null default now()
    )`;
    const applied = await tx<{ name: string }[]>`
      select name from schema_migrations where name = ${migrationName}
    `;
    if (applied.length > 0) return;
    await tx.unsafe(body);
    await tx`insert into schema_migrations (name) values (${migrationName})`;
  });
}

function ensureMigration(sql: postgres.Sql): Promise<void> {
  const existing = migrations.get(sql);
  if (existing !== undefined) return existing;
  const pending = applyTaskLedgerMigration(sql);
  migrations.set(sql, pending);
  return pending;
}

async function submitTask(
  sql: postgres.Sql,
  now: () => Date,
  subject: string,
  request: TaskSubmit,
  idempotencyKey: string,
): Promise<TaskAccepted> {
  const digest = canonicalPayloadSha256(request);
  const taskId = randomUUID();
  const at = now();
  return sql.begin(async (tx) => {
    const claimed = await tx<{ task_id: string }[]>`
      insert into task_claims (subject, idempotency_key, body_digest, task_id)
      values (${subject}, ${idempotencyKey}, ${digest}, ${taskId})
      on conflict (subject, idempotency_key) do nothing
      returning task_id
    `;
    if (claimed.length === 0) return replayClaim(tx, subject, idempotencyKey, digest);
    const task = insertedTask(taskId, subject, request, at);
    await insertTask(tx, task);
    return toAccepted(task);
  });
}

async function replayClaim(
  tx: postgres.TransactionSql,
  subject: string,
  idempotencyKey: string,
  digest: string,
): Promise<TaskAccepted> {
  const claims = await tx<ClaimRow[]>`
    select body_digest, task_id
    from task_claims
    where subject = ${subject} and idempotency_key = ${idempotencyKey}
  `;
  if (claims.length === 0) throw new LedgerConflict(changedBody);
  const claim = claims[0];
  if (claim.body_digest !== digest) throw new LedgerConflict(changedBody);
  const task = await selectTask(tx, claim.task_id, subject);
  if (task === undefined) throw new LedgerConflict(changedBody);
  return toAccepted(task);
}

async function commitTransition(
  sql: postgres.Sql,
  now: () => Date,
  input: TransitionInput,
): Promise<Task> {
  const digest = canonicalPayloadSha256(input.event);
  const at = now();
  return sql.begin(async (tx) => {
    const rows = await tx<TaskRow[]>`
      select id, created_by_sub, status, objective_digest, skill_version, agent_version,
             policy_version, budget, version, created_at, updated_at
      from tasks
      where id = ${input.taskId} and created_by_sub = ${input.subject}
      for update
    `;
    if (rows.length === 0) throw new LedgerConflict(missingTask);
    const current = toTask(rows[0]);
    if (current.version !== input.expectedVersion) throw new ConcurrentUpdate();
    const next = transition(current, input.to);
    await tx`
      update tasks
      set status = ${next.status}, version = ${next.version}, updated_at = ${at}
      where id = ${current.id}
    `;
    await writeOutbox(tx, input.event, digest);
    return { ...next, updatedAt: at.toISOString() };
  });
}

async function appendEvent(sql: postgres.Sql, event: OutboxEvent): Promise<'recorded' | 'replay'> {
  const digest = canonicalPayloadSha256(event);
  return sql.begin((tx) => writeOutbox(tx, event, digest));
}

async function selectTask(
  query: Query,
  taskId: string,
  subject: string,
): Promise<Task | undefined> {
  const rows = await query<TaskRow[]>`
    select id, created_by_sub, status, objective_digest, skill_version, agent_version,
           policy_version, budget, version, created_at, updated_at
    from tasks
    where id = ${taskId} and created_by_sub = ${subject}
  `;
  if (rows.length === 0) return undefined;
  return toTask(rows[0]);
}

async function insertTask(query: Query, task: Task): Promise<void> {
  await query`
    insert into tasks (
      id, created_by_sub, status, objective_digest, skill_version, agent_version,
      policy_version, budget, version, created_at, updated_at
    ) values (
      ${task.id}, ${task.createdBySub}, ${task.status}, ${task.objectiveDigest},
      ${task.skillVersion}, ${task.agentVersion}, ${task.policyVersion}, ${task.budget},
      ${task.version}, ${task.createdAt}, ${task.updatedAt}
    )
  `;
}

async function writeOutbox(
  query: postgres.TransactionSql,
  event: OutboxEvent,
  digest: string,
): Promise<'recorded' | 'replay'> {
  const inserted = await query<{ event_id: string }[]>`
    insert into outbox_events (event_id, destination, body_digest, payload)
    values (${event.event.eventId}, ${event.destination}, ${digest}, ${query.json(event)})
    on conflict (event_id) do nothing
    returning event_id
  `;
  if (inserted.length > 0) return 'recorded';
  const prior = await query<{ body_digest: string }[]>`
    select body_digest from outbox_events where event_id = ${event.event.eventId}
  `;
  if (prior.length === 0 || prior[0].body_digest !== digest) throw new LedgerConflict(changedEvent);
  return 'replay';
}

function insertedTask(taskId: string, subject: string, request: TaskSubmit, at: Date): Task {
  return taskSchema.parse({
    id: taskId,
    createdBySub: subject,
    status: 'QUEUED',
    objectiveDigest: canonicalPayloadSha256(request.objective),
    skillVersion: request.skillId,
    agentVersion: ledgerVersion,
    policyVersion: ledgerVersion,
    budget: request.executionPolicy.budgetUsd,
    version: 1,
    createdAt: at.toISOString(),
    updatedAt: at.toISOString(),
  });
}

function toAccepted(task: Task): TaskAccepted {
  return taskAcceptedSchema.parse({
    taskId: task.id,
    status: task.status,
    submittedAt: task.createdAt,
    statusUrl: `/v1/tasks/${task.id}`,
    traceId: task.id.replaceAll('-', ''),
  });
}

function toTask(row: TaskRow): Task {
  return taskSchema.parse({
    id: row.id,
    createdBySub: row.created_by_sub,
    status: row.status,
    objectiveDigest: row.objective_digest,
    skillVersion: row.skill_version,
    agentVersion: row.agent_version,
    policyVersion: row.policy_version,
    budget: Number(row.budget),
    version: row.version,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  });
}
