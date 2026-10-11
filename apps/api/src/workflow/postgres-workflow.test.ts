import { afterAll, beforeAll, beforeEach, expect, it } from 'vitest';

import { openSql, startDisposablePostgres } from '../ledger/disposable-postgres.js';
import { createMemoryLedgerPort } from '../ports/memory/ledger-port.js';
import { workflowPortContract } from '../ports/workflow.contract.js';

import { createLocalEngine } from './local-engine.js';
import {
  applyWorkflowMigration,
  createPostgresWorkflowLog,
  createPostgresWorkflowPort,
} from './postgres-workflow.js';

import type { DisposablePostgres } from '../ledger/disposable-postgres.js';
import type { Sql } from 'postgres';

let database: DisposablePostgres | undefined;
let sql: Sql | undefined;

beforeAll(async () => {
  database = await startDisposablePostgres();
  sql = openSql(database.url);
  await applyWorkflowMigration(sql);
}, 60_000);

afterAll(async () => {
  await sql?.end({ timeout: 1 });
  await database?.stop();
});

beforeEach(async () => {
  const query = requireSql();
  await query`truncate table workflow_attempts, workflow_receipts, workflow_signals, workflow_checkpoints`;
});

workflowPortContract(() => createPostgresWorkflowPort(requireSql()));

it('reads a receipt from a new connection', async () => {
  if (database === undefined) throw new Error('postgres');
  const first = openSql(database.url);
  expect(await createPostgresWorkflowLog(first).put('task-1', 'step_0001', 'receipt-1')).toBe(
    'recorded',
  );
  await first.end({ timeout: 1 });
  const second = openSql(database.url);
  try {
    const reader = createPostgresWorkflowLog(second);
    expect(await reader.list('task-1')).toEqual([{ stepId: 'step_0001', body: 'receipt-1' }]);
    expect(await reader.put('task-1', 'step_0001', 'receipt-1')).toBe('present');
  } finally {
    await second.end({ timeout: 1 });
  }
});

it('resumes a killed run from the checkpoint stored in postgres', async () => {
  const query = requireSql();
  const workflow = createPostgresWorkflowPort(query);
  const log = createPostgresWorkflowLog(query);
  const ledger = createMemoryLedgerPort();
  const entered = hold();
  const release = hold();
  const first = createLocalEngine({ workflow, log, ledger });
  const running = first.run({
    taskId: 'task-pg',
    subject: 'alice',
    steps: [
      { id: 'step_0001', run: () => Promise.resolve('r1') },
      {
        id: 'step_0002',
        run: async (context) => {
          entered.release();
          await release.promise;
          if (context.signal.aborted) throw new Error('aborted');
          return 'r2';
        },
      },
    ],
  });
  await entered.promise;
  first.halt('task-pg');
  release.release();
  expect((await running).status).toBe('RUNNING');
  const report = await createLocalEngine({
    workflow: createPostgresWorkflowPort(query),
    log: createPostgresWorkflowLog(query),
    ledger,
  }).run({
    taskId: 'task-pg',
    subject: 'alice',
    steps: [
      { id: 'step_0001', run: () => Promise.resolve('r1') },
      { id: 'step_0002', run: () => Promise.resolve('r2') },
    ],
  });
  expect(report.message).toBe('resumed from step_0002');
  expect(report.status).toBe('COMPLETED');
  expect(report.receipts).toEqual([
    { stepId: 'step_0001', body: 'r1' },
    { stepId: 'step_0002', body: 'r2' },
  ]);
});

it('keeps a terminal checkpoint when a later save arrives', async () => {
  const port = createPostgresWorkflowPort(requireSql());
  const cancelled = { taskId: 'task-term', stepId: 'step_0001', status: 'CANCELLED' as const };
  expect(await port.save(cancelled)).toEqual(cancelled);
  const completed = { ...cancelled, stepId: 'step_0002', status: 'COMPLETED' as const };
  expect(await port.save(completed)).toEqual(cancelled);
  expect(await port.read('task-term')).toEqual(cancelled);
});

function requireSql(): Sql {
  if (sql === undefined) throw new Error('postgres');
  return sql;
}

function hold(): { promise: Promise<void>; release: () => void } {
  const box: { release: () => void } = { release: () => {} };
  const promise = new Promise<void>((resolve) => {
    box.release = resolve;
  });
  return { promise, release: () => box.release() };
}
