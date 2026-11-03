import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest';

import { startDisposablePostgres, openSql } from '../ledger/disposable-postgres.js';
import { scheduleFixture } from '../scheduling/test-fixtures.js';

import { createPostgresSchedulePort } from './schedule-postgres.js';
import {
  CutoverRefused,
  readSchedulerOwner,
  rowClaimReady,
  switchSchedulerOwner,
  validateScheduleDue,
} from './schedule-row-claim-cutover.js';
import { createRowClaimSchedulePort } from './schedule-row-claim.js';
import { dockerAvailable, dropSchedulerSchema } from './schedule-row-claim.testkit.js';

import type { DisposablePostgres } from '../ledger/disposable-postgres.js';
import type { Sql } from 'postgres';

const live = dockerAvailable();
const T0 = '2026-10-14T10:00:00.000Z';
const T1 = '2026-10-14T10:01:00.000Z';
let database: DisposablePostgres;
let sql: Sql;
const pools: Sql[] = [];
const pool = () => {
  const p = openSql(database.url);
  pools.push(p);
  return p;
};
const due = { now: T1, limit: 10, owner: 'w', leaseMs: 30000 };

beforeAll(async () => {
  if (live) database = await startDisposablePostgres();
}, 60000);
beforeEach(async () => {
  if (!live) return;
  sql = pool();
  await dropSchedulerSchema(sql);
  await rowClaimReady(sql);
});
afterAll(async () => {
  if (!live) return;
  await Promise.all(pools.map((p) => p.end({ timeout: 1 })));
  await database.stop();
});

async function hold(statement: (tx: Sql) => Promise<unknown>) {
  let release: () => void = () => undefined;
  const gate = new Promise<void>((resolve) => (release = resolve));
  let ready: () => void = () => undefined;
  const locked = new Promise<void>((resolve) => (ready = resolve));
  const done = pool().begin(async (tx) => {
    await statement(tx as unknown as Sql);
    ready();
    await gate;
  });
  await locked;
  return async () => {
    release();
    await done;
  };
}

describe.skipIf(!live)('one writer protocol at a time', () => {
  test('starts as legacy: legacy writes work and the row-claim writer is refused', async () => {
    expect(await readSchedulerOwner(sql)).toMatchObject({ owner: 'legacy', generation: 1 });
    const legacy = createPostgresSchedulePort(sql);
    await legacy.create(scheduleFixture(), 'alice', T0);
    const rowclaim = createRowClaimSchedulePort(sql);
    await expect(rowclaim.create(scheduleFixture(), 'alice', T0)).rejects.toBeInstanceOf(
      CutoverRefused,
    );
    await expect(rowclaim.claimDue(due)).rejects.toBeInstanceOf(CutoverRefused);
  });

  test('flip backfills due rows, validates, then refuses the legacy writer in the database', async () => {
    const legacy = createPostgresSchedulePort(sql);
    const specs = [scheduleFixture(), scheduleFixture(), scheduleFixture()];
    for (const spec of specs) await legacy.create(spec, 'alice', T0);
    expect(await validateScheduleDue(sql)).toMatchObject({ activeTimedWithoutDue: 3 });
    expect(await switchSchedulerOwner(sql, 'legacy', 'rowclaim')).toMatchObject({
      owner: 'rowclaim',
      generation: 2,
    });
    expect(await validateScheduleDue(sql)).toEqual({ activeTimedWithoutDue: 0, duplicateSlots: 0 });
    await expect(legacy.create(scheduleFixture(), 'alice', T0)).rejects.toMatchObject({
      code: '55000',
    });
    await expect(
      legacy.claim({ ...due, scheduleId: specs[0].id, fireAt: T1, event: null }),
    ).rejects.toMatchObject({
      code: '55000',
    });
    expect(await createRowClaimSchedulePort(sql).claimDue(due)).toHaveLength(3);
  });

  test('flip to rowclaim is refused while a legacy transaction is in flight', async () => {
    const free = await hold((tx) => tx`select pg_advisory_xact_lock(7013)`);
    try {
      await expect(switchSchedulerOwner(sql, 'legacy', 'rowclaim')).rejects.toThrow(
        'legacy writer',
      );
    } finally {
      await free();
    }
    expect((await readSchedulerOwner(sql)).owner).toBe('legacy');
  });

  test('flip back is refused while a row-claim transaction is in flight, and a wrong from is refused', async () => {
    await switchSchedulerOwner(sql, 'legacy', 'rowclaim');
    const free = await hold(
      (tx) => tx`select owner from scheduler_owner where singleton for share`,
    );
    try {
      await expect(
        switchSchedulerOwner(sql, 'rowclaim', 'legacy', { lockTimeoutMs: 200 }),
      ).rejects.toThrow('row-claim writer active');
    } finally {
      await free();
    }
    await expect(switchSchedulerOwner(sql, 'legacy', 'rowclaim')).rejects.toBeInstanceOf(
      CutoverRefused,
    );
    expect((await readSchedulerOwner(sql)).owner).toBe('rowclaim');
  });

  test('rollback and forward repair keep one run per slot and a continuous cursor', async () => {
    const spec = scheduleFixture();
    const legacy = createPostgresSchedulePort(sql);
    await legacy.create(spec, 'alice', T0);
    await switchSchedulerOwner(sql, 'legacy', 'rowclaim');
    const rowclaim = createRowClaimSchedulePort(sql);
    const [run] = await rowclaim.claimDue(due);
    await switchSchedulerOwner(sql, 'rowclaim', 'legacy');
    await expect(rowclaim.claimDue(due)).rejects.toBeInstanceOf(CutoverRefused);
    const claimInput = {
      scheduleId: spec.id,
      fireAt: T1,
      now: T1,
      event: null,
      owner: 'x',
      leaseMs: 30000,
    };
    expect(await legacy.claim(claimInput)).toBeUndefined();
    expect((await legacy.read('alice', spec.id))?.cursor).toBe(T1);
    expect(await legacy.runs(spec.id)).toMatchObject([{ id: run.id, fence: 1 }]);
    await switchSchedulerOwner(sql, 'legacy', 'rowclaim');
    expect(await createRowClaimSchedulePort(sql).claimDue(due)).toEqual([]);
    expect(await readSchedulerOwner(sql)).toMatchObject({ owner: 'rowclaim', generation: 4 });
  });
});
