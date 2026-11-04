import { afterAll, beforeAll, beforeEach, describe, expect, test, vi } from 'vitest';

import { openSql, startDisposablePostgres } from '../ledger/disposable-postgres.js';
import { claimDueWithOutbox } from '../outbox/claim-with-outbox.js';
import { outboxReady } from '../outbox/migration.js';
import { createMemoryQueue, dropOutboxSchema } from '../outbox/outbox.testkit.js';
import { rowClaimReady, switchSchedulerOwner } from '../ports/schedule-row-claim-cutover.js';
import { createRowClaimSchedulePort } from '../ports/schedule-row-claim.js';
import { dockerAvailable, dropSchedulerSchema } from '../ports/schedule-row-claim.testkit.js';
import { scheduleFixture } from '../scheduling/test-fixtures.js';

import { buildBackgroundLoops } from './background.js';
import { readWiring } from './flags.js';
import { prepareRoutines } from './routines.js';

import type { DisposablePostgres } from '../ledger/disposable-postgres.js';
import type { Sql } from 'postgres';

const live = dockerAvailable();
const T0 = '2026-10-14T10:00:00.000Z';
const T1 = '2026-10-14T10:01:00.000Z';
let database: DisposablePostgres;
let sql: Sql;
const pools: Sql[] = [];

beforeAll(async () => {
  if (live) {
    database = await startDisposablePostgres();
  }
}, 60_000);
beforeEach(async () => {
  if (!live) return;
  sql = openSql(database.url);
  pools.push(sql);
  await dropSchedulerSchema(sql);
  await dropOutboxSchema(sql);
  await rowClaimReady(sql);
  await switchSchedulerOwner(sql, 'legacy', 'rowclaim');
  await outboxReady(sql);
});
afterAll(async () => {
  if (!live) return;
  await Promise.all(pools.map((pool) => pool.end({ timeout: 1 })));
  await database.stop();
});

const outboxEnv = {
  AW_OUTBOX_PUBLISHER: 'on',
  AW_QUEUE_PROJECT: 'proj',
  AW_QUEUE_LOCATION: 'us-central1',
  AW_QUEUE_NAME: 'dispatch',
  AW_WORKER_URL: 'https://api.example.com/internal/deliveries',
  AW_QUEUE_OIDC_SA: 'dispatcher@proj.iam.gserviceaccount.com',
  AW_OUTBOX_LEASE_MS: '30000',
  AW_OUTBOX_INTERVAL_MS: '20',
  AW_EXECUTION_SWEEPER: 'on',
  AW_WORKER_LEASE_MS: '30000',
  AW_SWEEP_REDRIVE_AFTER_MS: '600000',
  AW_SWEEP_MAX_REDRIVES: '2',
  AW_SWEEP_INTERVAL_MS: '20',
};

describe.skipIf(!live)('enabled loops against a real database', () => {
  test('the outbox loop publishes a claimed run through the queue and stops gracefully', async () => {
    const port = createRowClaimSchedulePort(sql);
    const spec = scheduleFixture();
    await port.create(spec, 'alice', T0);
    const runs = await claimDueWithOutbox(
      sql,
      {},
      { now: T1, limit: 10, owner: 'dispatcher', leaseMs: 30_000 },
    );
    expect(runs).toHaveLength(1);

    const memory = createMemoryQueue();
    const onError = vi.fn();
    const loops = await buildBackgroundLoops({
      sql,
      wiring: readWiring(outboxEnv),
      now: () => new Date(T1),
      onError,
      queue: memory.queue,
    });
    expect(loops).toHaveLength(2);
    for (const loop of loops) loop.start();
    await vi.waitFor(() => expect(memory.calls).toBe(1), { timeout: 5000 });
    for (const loop of loops) await loop.stop();
    const rows = await sql<{ state: string }[]>`select state from dispatch_outbox`;
    expect(rows.map((row) => row.state)).toEqual(['published']);
    expect(onError).not.toHaveBeenCalled();
    const callsAfterStop = memory.calls;
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(memory.calls).toBe(callsAfterStop);
  });

  test('with no flags no loop exists, so nothing publishes', async () => {
    const port = createRowClaimSchedulePort(sql);
    await port.create(scheduleFixture(), 'alice', T0);
    await claimDueWithOutbox(sql, {}, { now: T1, limit: 10, owner: 'dispatcher', leaseMs: 30_000 });
    const loops = await buildBackgroundLoops({
      sql,
      wiring: readWiring({}),
      now: () => new Date(T1),
      onError: vi.fn(),
    });
    expect(loops).toEqual([]);
    const rows = await sql<{ state: string }[]>`select state from dispatch_outbox`;
    expect(rows.map((row) => row.state)).toEqual(['pending']);
  });
});

describe.skipIf(!live)('standing-grant routines gate', () => {
  test('stays closed without the switch and the approval reference', async () => {
    expect(await prepareRoutines(sql, {}, () => new Date(T1))).toBeUndefined();
    expect(
      await prepareRoutines(sql, { AW_STANDING_GRANTS: 'on' }, () => new Date(T1)),
    ).toBeUndefined();
    const tables = await sql<{ n: number }[]>`
      select count(*)::int as n from information_schema.tables where table_name = 'tw_routines'`;
    expect(tables[0].n).toBe(0);
  });

  test('when open it migrates and denies every spec until the service is bound', async () => {
    const wiring = await prepareRoutines(
      sql,
      { AW_STANDING_GRANTS: 'on', AW_STANDING_GRANTS_O04_REF: 'O04-1' },
      () => new Date(T1),
    );
    expect(wiring).toBeDefined();
    const base = () =>
      Promise.resolve({
        active: true,
        subject: 's',
        teams: [],
        privilege: {},
        context: {},
      }) as never;
    const guarded = wiring!.guard(base);
    expect((await guarded({ id: 'r1' } as never)).active).toBe(false);
  });
});
