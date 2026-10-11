import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { workflowCheckpointSchema, workflowSignalSchema } from '@agent-works/domain';

import type { WorkflowLog, WorkflowReceipt } from './workflow-log.js';
import type { WorkflowPort } from '../ports/workflow.js';
import type { WorkflowCheckpoint, WorkflowSignal } from '@agent-works/domain';
import type postgres from 'postgres';

const migrationName = '0004_workflow.sql';
const migrationLock = 7004;
const migrationPath = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '../../migrations/0004_workflow.sql',
);
const migrations = new WeakMap<postgres.Sql, Promise<void>>();

export function createPostgresWorkflowPort(sql: postgres.Sql): WorkflowPort {
  const ready = ensureMigration(sql);
  return {
    save(checkpoint) {
      return ready.then(() => saveCheckpoint(sql, checkpoint));
    },
    read(taskId) {
      return ready.then(() => readCheckpoint(sql, taskId));
    },
    signal(signal) {
      return ready.then(() => recordSignal(sql, signal));
    },
  };
}

export function createPostgresWorkflowLog(sql: postgres.Sql): WorkflowLog {
  const ready = ensureMigration(sql);
  return {
    put(taskId, stepId, body) {
      return ready.then(() => putReceipt(sql, taskId, stepId, body));
    },
    list(taskId) {
      return ready.then(() => listReceipts(sql, taskId));
    },
    bump(taskId, stepId) {
      return ready.then(() => bumpAttempts(sql, taskId, stepId));
    },
  };
}

export async function applyWorkflowMigration(sql: postgres.Sql): Promise<void> {
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
  const pending = applyWorkflowMigration(sql);
  migrations.set(sql, pending);
  return pending;
}

async function saveCheckpoint(
  sql: postgres.Sql,
  checkpoint: WorkflowCheckpoint,
): Promise<WorkflowCheckpoint> {
  const parsed = workflowCheckpointSchema.parse(checkpoint);
  const rows = await sql<{ task_id: string; step_id: string; status: string }[]>`
    insert into workflow_checkpoints (task_id, step_id, status)
    values (${parsed.taskId}, ${parsed.stepId}, ${parsed.status})
    on conflict (task_id) do update
    set step_id = excluded.step_id, status = excluded.status
    where workflow_checkpoints.status <> 'COMPLETED'
      and workflow_checkpoints.status <> 'FAILED'
      and workflow_checkpoints.status <> 'CANCELLED'
    returning task_id, step_id, status
  `;
  const row = rows.at(0);
  if (row !== undefined) return checkpointFrom(row);
  const stored = await readCheckpoint(sql, parsed.taskId);
  return stored ?? parsed;
}

async function readCheckpoint(
  sql: postgres.Sql,
  taskId: string,
): Promise<WorkflowCheckpoint | undefined> {
  const rows = await sql<{ task_id: string; step_id: string; status: string }[]>`
    select task_id, step_id, status from workflow_checkpoints where task_id = ${taskId}
  `;
  const row = rows.at(0);
  if (row === undefined) return undefined;
  return checkpointFrom(row);
}

function checkpointFrom(row: {
  readonly task_id: string;
  readonly step_id: string;
  readonly status: string;
}): WorkflowCheckpoint {
  return workflowCheckpointSchema.parse({
    taskId: row.task_id,
    stepId: row.step_id,
    status: row.status,
  });
}

async function recordSignal(
  sql: postgres.Sql,
  signal: WorkflowSignal,
): Promise<'recorded' | 'duplicate'> {
  const parsed = workflowSignalSchema.parse(signal);
  const inserted = await sql<{ signal_id: string }[]>`
    insert into workflow_signals (task_id, signal_id, kind)
    values (${parsed.taskId}, ${parsed.signalId}, ${parsed.kind})
    on conflict (task_id, signal_id) do nothing
    returning signal_id
  `;
  return inserted.length > 0 ? 'recorded' : 'duplicate';
}

async function putReceipt(
  sql: postgres.Sql,
  taskId: string,
  stepId: string,
  body: string,
): Promise<'recorded' | 'present'> {
  return sql.begin(async (tx) => {
    const inserted = await tx<{ step_id: string }[]>`
      insert into workflow_receipts (task_id, step_id, body)
      values (${taskId}, ${stepId}, ${body})
      on conflict (task_id, step_id) do nothing
      returning step_id
    `;
    if (inserted.length > 0) return 'recorded';
    const prior = await tx<{ body: string }[]>`
      select body from workflow_receipts where task_id = ${taskId} and step_id = ${stepId}
    `;
    const row = prior.at(0);
    if (row === undefined || row.body !== body) throw new Error('receipt changed');
    return 'present';
  });
}

async function listReceipts(
  sql: postgres.Sql,
  taskId: string,
): Promise<readonly WorkflowReceipt[]> {
  const rows = await sql<{ step_id: string; body: string }[]>`
    select step_id, body from workflow_receipts where task_id = ${taskId} order by seq
  `;
  return rows.map((row) => ({ stepId: row.step_id, body: row.body }));
}

async function bumpAttempts(sql: postgres.Sql, taskId: string, stepId: string): Promise<number> {
  const rows = await sql<{ count: number }[]>`
    insert into workflow_attempts (task_id, step_id, count)
    values (${taskId}, ${stepId}, 1)
    on conflict (task_id, step_id) do update
    set count = workflow_attempts.count + 1
    returning count
  `;
  const row = rows.at(0);
  if (row === undefined) throw new Error('attempt');
  return row.count;
}
