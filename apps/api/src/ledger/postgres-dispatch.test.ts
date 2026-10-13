import { afterAll, beforeAll, beforeEach, expect, it } from 'vitest';

import { acceptInput, dispatchPortContract } from '../ports/dispatch-port.contract.js';

import { openSql, startDisposablePostgres } from './disposable-postgres.js';
import { createPostgresDispatchHarness, createPostgresDispatchPort } from './postgres-dispatch.js';
import { applyTaskLedgerMigration } from './postgres-ledger.js';

import type { DisposablePostgres } from './disposable-postgres.js';
import type { Sql } from 'postgres';

let database: DisposablePostgres | undefined;
let sql: Sql | undefined;

beforeAll(async () => {
  database = await startDisposablePostgres();
  sql = openSql(database.url);
  await applyTaskLedgerMigration(sql);
}, 60_000);

afterAll(async () => {
  await sql?.end({ timeout: 1 });
  await database?.stop();
});

beforeEach(async () => {
  const query = requireSql();
  await query`truncate table task_transition_receipts, task_deliveries, outbox_events, task_claims, tasks`;
});

const startedAt = '2026-10-10T10:00:00.000Z';

dispatchPortContract(() => createPostgresDispatchHarness(requireSql()));

it('accepts through a port created without a fault seam', async () => {
  const accepted = await createPostgresDispatchPort(requireSql(), () => new Date(startedAt)).accept(
    acceptInput,
  );
  expect(accepted).toMatchObject({ status: 'QUEUED', submittedAt: startedAt });
});

function requireSql(): Sql {
  if (sql === undefined) throw new Error('postgres');
  return sql;
}
