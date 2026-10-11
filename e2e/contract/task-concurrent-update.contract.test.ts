import { afterAll, beforeAll, expect, it } from 'vitest';

import { openSql, startDisposablePostgres } from '../../apps/api/src/ledger/disposable-postgres.js';
import {
  ConcurrentUpdate,
  applyTaskLedgerMigration,
  createPostgresLedgerPort,
} from '../../apps/api/src/ledger/postgres-ledger.js';
import { writePng } from '../png.mjs';
import { appendResult } from '../results.mjs';

import type { DisposablePostgres } from '../../apps/api/src/ledger/disposable-postgres.js';
import type { OutboxEvent, TaskSubmit } from '@agent-works/domain';

const at = new Date('2026-10-10T10:00:00.000Z');

const request: TaskSubmit = {
  objective: 'Summarize the runbook',
  skillId: 'ask',
  sourceAllowlist: ['drive'],
  requestedOutputs: ['answer'],
  executionPolicy: { mode: 'interactive', budgetUsd: 0.1, deadlineSeconds: 30 },
};

let database: DisposablePostgres | undefined;
let sql: ReturnType<typeof openSql> | undefined;

beforeAll(async () => {
  database = await startDisposablePostgres();
  sql = openSql(database.url);
  await applyTaskLedgerMigration(sql);
}, 120_000);

afterAll(async () => {
  await sql?.end({ timeout: 1 });
  await database?.stop();
});

it('task.concurrent-update', async () => {
  if (sql === undefined) throw new Error('postgres');
  const ledger = createPostgresLedgerPort(sql, () => at);
  const accepted = await ledger.submit('alice', request, 'concurrent-update');
  const results = await Promise.allSettled([
    ledger.transition({
      subject: 'alice',
      taskId: accepted.taskId,
      expectedVersion: 1,
      to: 'RUNNING',
      event: outbox('evt-contract-a', accepted.taskId),
    }),
    ledger.transition({
      subject: 'alice',
      taskId: accepted.taskId,
      expectedVersion: 1,
      to: 'RUNNING',
      event: outbox('evt-contract-b', accepted.taskId),
    }),
  ]);
  const rejected = results.filter((result) => result.status === 'rejected');
  const fulfilled = results.filter((result) => result.status === 'fulfilled');
  expect(fulfilled).toHaveLength(1);
  expect(rejected).toHaveLength(1);
  const reason = rejected[0]?.status === 'rejected' ? rejected[0].reason : undefined;
  expect(reason).toBeInstanceOf(ConcurrentUpdate);
  expect(await ledger.read('alice', accepted.taskId)).toMatchObject({
    status: 'RUNNING',
    version: 2,
  });
  appendResult({ id: 'task.concurrent-update', status: 'passed' });
  writePng('e2e/artifacts/task.concurrent-update/task-concurrent-update.png', 'passed');
});

function outbox(eventId: string, taskId: string): OutboxEvent {
  return {
    destination: 'work',
    event: {
      eventId,
      eventType: 'task',
      schemaVersion: '1',
      occurredAt: '2026-10-10T10:00:00.000Z',
      taskId,
      stepId: 'transition',
      traceId: 'trace',
      initiatorSubject: 'alice',
      agentPrincipal: 'agent:postgres',
      tool: null,
      policyDecisionId: null,
      approvalId: null,
      requestDigestSha256: null,
      outcome: 'SUCCESS',
      externalObjectRef: null,
      prevDigest: null,
    },
  };
}
