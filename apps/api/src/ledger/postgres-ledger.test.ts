import { IllegalTaskTransition } from '@agent-works/domain';
import { afterAll, beforeAll, beforeEach, expect, it } from 'vitest';

import { ledgerPortContract } from '../ports/ledger-port.contract.js';

import { openSql, startDisposablePostgres } from './disposable-postgres.js';
import {
  ConcurrentUpdate,
  applyTaskLedgerMigration,
  createPostgresLedgerPort,
} from './postgres-ledger.js';

import type { DisposablePostgres } from './disposable-postgres.js';
import type { TaskLedger } from './postgres-ledger.js';
import type { OutboxEvent, TaskSubmit } from '@agent-works/domain';
import type { Sql } from 'postgres';

const at = new Date('2026-10-10T10:00:00.000Z');

const request: TaskSubmit = {
  objective: 'Summarize the runbook',
  skillId: 'ask',
  sourceAllowlist: ['drive'],
  requestedOutputs: ['answer'],
  executionPolicy: { mode: 'interactive', budgetUsd: 0.1, deadlineSeconds: 30 },
};

let database: DisposablePostgres | undefined;
let sql: Sql | undefined;
let port: TaskLedger;

beforeAll(async () => {
  database = await startDisposablePostgres();
  sql = openSql(database.url);
  await applyTaskLedgerMigration(sql);
  port = createPostgresLedgerPort(sql, () => at);
}, 60_000);

afterAll(async () => {
  await sql?.end({ timeout: 1 });
  await database?.stop();
});

beforeEach(async () => {
  const query = requireSql();
  await query`truncate table task_transition_receipts, task_deliveries, outbox_events, task_claims, tasks`;
});

ledgerPortContract(() => port);

it('one of two writers with the same version gets ConcurrentUpdate', async () => {
  const query = requireSql();
  const accepted = await port.submit('alice', request, 'race-key');
  const results = await Promise.allSettled([
    port.transition({
      subject: 'alice',
      taskId: accepted.taskId,
      expectedVersion: 1,
      to: 'RUNNING',
      event: outbox('evt-race-a', accepted.taskId),
    }),
    port.transition({
      subject: 'alice',
      taskId: accepted.taskId,
      expectedVersion: 1,
      to: 'RUNNING',
      event: outbox('evt-race-b', accepted.taskId),
    }),
  ]);
  const rejected = results.find((result) => result.status === 'rejected');
  const fulfilled = results.find((result) => result.status === 'fulfilled');
  expect(fulfilled?.status).toBe('fulfilled');
  expect(rejected?.status).toBe('rejected');
  expect(rejected?.status === 'rejected' ? rejected.reason : undefined).toBeInstanceOf(
    ConcurrentUpdate,
  );
  expect(await port.read('alice', accepted.taskId)).toMatchObject({
    status: 'RUNNING',
    version: 2,
  });
  expect(await outboxCount(query)).toBe(1);
});

it('a new connection reads the task after the first pool closes', async () => {
  if (database === undefined) throw new Error('postgres');
  const first = openSql(database.url);
  const writer = createPostgresLedgerPort(first, () => at);
  const accepted = await writer.submit('alice', request, 'restart-key');
  await first.end({ timeout: 1 });
  const second = openSql(database.url);
  try {
    const reader = createPostgresLedgerPort(second, () => at);
    expect(await reader.read('alice', accepted.taskId)).toMatchObject({
      id: accepted.taskId,
      createdBySub: 'alice',
      status: 'QUEUED',
      version: 1,
    });
  } finally {
    await second.end({ timeout: 1 });
  }
});

it('a repeated submit returns the original acceptance after the task moves', async () => {
  const accepted = await port.submit('alice', request, 'replay-key');
  await port.transition({
    subject: 'alice',
    taskId: accepted.taskId,
    expectedVersion: 1,
    to: 'RUNNING',
    event: outbox('evt-replay-status', accepted.taskId),
  });
  expect(await port.submit('alice', request, 'replay-key')).toEqual(accepted);
  expect(await port.read('alice', accepted.taskId)).toMatchObject({
    status: 'RUNNING',
    version: 2,
  });
});

it('a transition keeps an identical outbox event and still advances', async () => {
  const query = requireSql();
  const accepted = await port.submit('alice', request, 'shared-event-key');
  const event = outbox('evt-shared', accepted.taskId);
  expect(await port.append(event)).toBe('recorded');
  await port.transition({
    subject: 'alice',
    taskId: accepted.taskId,
    expectedVersion: 1,
    to: 'RUNNING',
    event,
  });
  expect(await port.read('alice', accepted.taskId)).toMatchObject({
    status: 'RUNNING',
    version: 2,
  });
  expect(await outboxCount(query)).toBe(1);
});

it('an illegal transition writes no outbox event', async () => {
  const query = requireSql();
  const accepted = await port.submit('alice', request, 'fail-key');
  const before = await outboxCount(query);
  await expect(
    port.transition({
      subject: 'alice',
      taskId: accepted.taskId,
      expectedVersion: 1,
      to: 'COMPLETED',
      event: outbox('evt-fail', accepted.taskId),
    }),
  ).rejects.toBeInstanceOf(IllegalTaskTransition);
  expect(await port.read('alice', accepted.taskId)).toMatchObject({
    status: 'QUEUED',
    version: 1,
  });
  expect(await outboxCount(query)).toBe(before);
});

it('applies dispatch tables when the task migration is already recorded', async () => {
  const query = requireSql();
  await query`drop table if exists task_transition_receipts, task_deliveries`;
  await query`delete from schema_migrations where name = '0007_task_dispatch.sql'`;
  await applyTaskLedgerMigration(query);
  const tables = await query<{ name: string }[]>`
    select table_name as name
    from information_schema.tables
    where table_schema = 'public'
      and table_name in ('task_deliveries', 'task_transition_receipts')
    order by table_name
  `;
  expect(tables.map((row) => row.name)).toEqual(['task_deliveries', 'task_transition_receipts']);
});

function requireSql(): Sql {
  if (sql === undefined) throw new Error('postgres');
  return sql;
}

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

function outboxCount(query: Sql): Promise<number> {
  return query<{ count: number }[]>`select count(*)::int as count from outbox_events`.then(
    (rows) => {
      if (rows.length === 0) return 0;
      return rows[0].count;
    },
  );
}
