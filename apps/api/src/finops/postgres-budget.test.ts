import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { openSql } from '../ledger/disposable-postgres.js';
import { createPostgresDispatchPort } from '../ledger/postgres-dispatch.js';
import { createPostgresLedgerPort } from '../ledger/postgres-ledger.js';
import { startDrillPostgres } from '../reliability/disposable-postgres.js';
import { createDlqService } from '../reliability/dlq-service.js';
import { fixtureInstant, fixtureRequest } from '../reliability/fixtures.js';
import { createPostgresDlqStore } from '../reliability/postgres-dlq.js';

import { budgetGuard } from './budget-guard.js';
import { applyBudgetMigration } from './migration.js';
import { createPostgresBudgetPort } from './postgres-budget.js';
import { showback } from './showback.js';

import type { BudgetCharge } from '#domain-budget';
import type { DisposablePostgres } from '../ledger/disposable-postgres.js';
import type { Sql } from 'postgres';

let database: DisposablePostgres | undefined;
let sql: Sql | undefined;
function query(): Sql {
  if (sql === undefined) throw new Error('fixture database');
  return sql;
}
beforeAll(async () => {
  database = await startDrillPostgres();
  sql = openSql(database.url);
  await applyBudgetMigration(sql);
}, 60_000);
afterAll(async () => {
  await sql?.end({ timeout: 1 });
  await database?.stop();
});
const limits = {
  approval: 'PLACEHOLDER' as const,
  estimatedCostMicros: 100,
  inferenceSteps: 10,
  parallelism: 10,
};
const charge: BudgetCharge = {
  operationId: 'pg-op',
  scope: { taskId: 'pg-task', userSubject: 'alice', sponsor: 'platform', window: 'test-window' },
  estimatedCostMicros: 70,
  inferenceSteps: 1,
  parallelism: 1,
};
describe('persistent budgets and DLQ', () => {
  it('applies migration 0011 idempotently', async () => {
    await applyBudgetMigration(query());
    const rows = await query()<
      { count: number }[]
    >`select count(*)::int as count from schema_migrations where name = '0011_budgets.sql'`;
    expect(rows[0].count).toBe(1);
  });
  it('serializes user budget reservations across concurrent tasks and persists audit evidence', async () => {
    const port = createPostgresBudgetPort(query());
    const guard = budgetGuard(port, { task: limits, user: limits, mode: 'isolated-test-enforce' });
    const result = await Promise.allSettled([
      guard.reserve(charge),
      guard.reserve({
        ...charge,
        operationId: 'pg-op-2',
        scope: { ...charge.scope, taskId: 'pg-task-2' },
      }),
    ]);
    expect(result.filter((row) => row.status === 'fulfilled')).toHaveLength(1);
    expect(result.filter((row) => row.status === 'rejected')).toHaveLength(1);
    const events = await port.events();
    expect(events).toHaveLength(2);
    expect(showback(events)[0].estimatedCostMicros).toBe(70);
    const allowed = result[0].status === 'fulfilled' ? 'pg-op' : 'pg-op-2';
    await port.release(allowed);
    await port.release(allowed);
    expect(await port.events()).toHaveLength(3);
  });
  it('persists DLQ decisions and preserves acceptance identity across store restart', async () => {
    const db = query();
    const clock = () => new Date(fixtureInstant);
    const dispatch = createPostgresDispatchPort(db, clock);
    const ledger = createPostgresLedgerPort(db, clock);
    const accepted = await dispatch.accept(fixtureRequest);
    const lease = await dispatch.claim('reviewer', 60_000);
    if (lease === undefined) throw new Error('lease');
    const store = createPostgresDlqStore(db);
    const service = createDlqService(store, dispatch, ledger);
    const entry = await service.stuck({
      entryId: 'pg-dlq',
      taskId: accepted.taskId,
      subject: 'alice',
      idempotencyKey: fixtureRequest.idempotencyKey,
      riskyWrite: false,
      reason: 'stuck',
      createdAt: fixtureInstant,
    });
    await service.requeue(
      entry.entryId,
      {
        decisionId: 'pg-review',
        operator: 'fixture',
        reason: 'receipt inspected',
        occurredAt: fixtureInstant,
      },
      lease,
      fixtureInstant,
      1,
    );
    expect(await createPostgresDlqStore(db).read(entry.entryId)).toMatchObject({
      state: 'requeued',
      idempotencyKey: fixtureRequest.idempotencyKey,
    });
    expect((await dispatch.accept(fixtureRequest)).taskId).toBe(accepted.taskId);
    expect(await store.decisions()).toHaveLength(2);
  });
});
