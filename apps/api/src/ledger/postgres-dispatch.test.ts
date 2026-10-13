import { afterAll, beforeAll, beforeEach, expect, it, vi } from 'vitest';

import { acceptInput, dispatchPortContract } from '../ports/dispatch-port.contract.js';
import { proofOf } from '../ports/dispatch-port.js';
import { LedgerConflict } from '../ports/ledger-port.js';
import { taskDispatcherContract } from '../skills/task-dispatcher.contract.js';

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
taskDispatcherContract(() => createPostgresDispatchHarness(requireSql()));

it('accepts through a port created without a fault seam', async () => {
  const accepted = await createPostgresDispatchPort(requireSql(), () => new Date(startedAt)).accept(
    acceptInput,
  );
  expect(accepted).toMatchObject({ status: 'QUEUED', submittedAt: startedAt });
});

it.each([
  { at: '2026-10-10T10:00:30.000Z', expired: false },
  { at: '2026-10-10T10:01:00.000Z', expired: true },
])('uses post-lock time to renew a lease at $at', async ({ at, expired }) => {
  const query = requireSql();
  let now = new Date(startedAt);
  const dispatch = createPostgresDispatchPort(query, () => now);
  await dispatch.accept(acceptInput);
  const claimed = await dispatch.claim('worker-a', 60_000);
  if (claimed === undefined) throw new Error('missing claim');

  const blocker = await query.reserve();
  let pending: ReturnType<typeof dispatch.renew> | undefined;
  try {
    await blocker`begin`;
    await blocker`select task_id from task_deliveries where task_id = ${claimed.taskId} for update`;
    pending = dispatch.renew(proofOf(claimed), 120_000);
    await vi.waitFor(async () => {
      const rows = await query<{ count: number }[]>`
        select count(*)::int as count from pg_stat_activity
        where datname = current_database() and wait_event_type = 'Lock'
          and query like '%for update of d%'
      `;
      expect(rows[0].count).toBe(1);
    });
    now = new Date(at);
    await blocker`commit`;
    if (expired) {
      await expect(pending).rejects.toBeInstanceOf(LedgerConflict);
    } else {
      await expect(pending).resolves.toMatchObject({
        leaseUntil: '2026-10-10T10:02:30.000Z',
        fencingToken: claimed.fencingToken,
      });
    }
  } finally {
    await blocker`rollback`;
    blocker.release();
    await pending?.catch(() => undefined);
  }
});

function requireSql(): Sql {
  if (sql === undefined) throw new Error('postgres');
  return sql;
}
