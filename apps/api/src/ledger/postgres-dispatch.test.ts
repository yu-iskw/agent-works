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

it('rejects a stale fencing token after an explicitly expired and reclaimed lease', async () => {
  // Freeze both ports on one clock; database latency cannot expire the new lease.
  const harness = createPostgresDispatchHarness(requireSql());
  harness.setNow(startedAt);
  const { dispatch, ledger } = harness.open();
  const accepted = await dispatch.accept(acceptInput);
  const old = await dispatch.claim('old-worker', 60_000);
  if (old === undefined) throw new Error('missing old claim');
  harness.setNow(old.leaseUntil);
  const current = await dispatch.claim('new-worker', 60_000);
  if (current === undefined) throw new Error('missing current claim');
  expect(current.fencingToken).toBe(old.fencingToken + 1);
  expect(current.workerId).toBe('new-worker');
  await expect(dispatch.renew(proofOf(old), 60_000)).rejects.toBeInstanceOf(LedgerConflict);
  await expect(dispatch.release(proofOf(old))).rejects.toBeInstanceOf(LedgerConflict);
  await expect(
    dispatch.scheduleRetry(proofOf(old), '2026-10-10T10:02:00.000Z', 2),
  ).rejects.toBeInstanceOf(LedgerConflict);
  expect(await ledger.read(acceptInput.subject, accepted.taskId)).toMatchObject({
    status: 'QUEUED',
    version: 1,
  });
  expect(await ledger.readReceipt(acceptInput.subject, accepted.taskId)).toBeUndefined();
  expect(await dispatch.renew(proofOf(current), 120_000)).toMatchObject({
    fencingToken: current.fencingToken,
    leaseUntil: '2026-10-10T10:03:00.000Z',
  });
  expect(await dispatch.claim('third-worker', 60_000)).toBeUndefined();
  const submitted = (await ledger.events(acceptInput.subject, accepted.taskId))[0];
  const event = {
    ...submitted,
    event: { ...submitted.event, eventId: 'fenced-completion', eventType: 'task.completed' },
  };
  await ledger.transition({
    subject: acceptInput.subject,
    taskId: accepted.taskId,
    expectedVersion: 1,
    to: 'RUNNING',
    lease: proofOf(current),
    event: {
      ...event,
      event: { ...event.event, eventId: 'fenced-running', eventType: 'task.running' },
    },
  });
  const completion = {
    subject: acceptInput.subject,
    taskId: accepted.taskId,
    expectedVersion: 2,
    to: 'COMPLETED' as const,
    event,
    receipt: { ref: 'FAKE-1', digestSha256: 'a'.repeat(64) },
  };
  await expect(ledger.transition({ ...completion, lease: proofOf(old) })).rejects.toBeInstanceOf(
    LedgerConflict,
  );
  expect(await ledger.readOutbox(event.event.eventId)).toBeUndefined();
  expect(await ledger.readReceipt(acceptInput.subject, accepted.taskId)).toBeUndefined();
  expect(await ledger.transition({ ...completion, lease: proofOf(current) })).toMatchObject({
    status: 'COMPLETED',
    version: 3,
  });
  expect(await ledger.readReceipt(acceptInput.subject, accepted.taskId)).toEqual(
    completion.receipt,
  );
  expect(await ledger.readOutbox(event.event.eventId)).toEqual(event);
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
