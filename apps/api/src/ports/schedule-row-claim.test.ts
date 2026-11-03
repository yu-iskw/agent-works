import { scheduleRunId } from '@agent-works/domain';
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest';

import { startDisposablePostgres, openSql } from '../ledger/disposable-postgres.js';
import { createScheduler } from '../scheduling/service.js';
import { schedulerFixture, scheduleFixture } from '../scheduling/test-fixtures.js';

import { schedulePortContract } from './schedule-port.contract.js';
import { ScheduleConflict } from './schedule-port.js';
import { rowClaimReady, switchSchedulerOwner } from './schedule-row-claim-cutover.js';
import { createRowClaimSchedulePort } from './schedule-row-claim.js';
import { dockerAvailable, dropSchedulerSchema } from './schedule-row-claim.testkit.js';

import type { RowClaimSchedulePort } from './schedule-row-claim.js';
import type { DisposablePostgres } from '../ledger/disposable-postgres.js';
import type { ScheduleSpec } from '@agent-works/domain';
import type { Sql } from 'postgres';

const live = dockerAvailable();
const T0 = '2026-10-14T10:00:00.000Z';
const T1 = '2026-10-14T10:01:00.000Z';
let database: DisposablePostgres;
let sql: Sql;
let port: RowClaimSchedulePort;
const pools: Sql[] = [];
const pool = () => {
  const p = openSql(database.url);
  pools.push(p);
  return p;
};
const lease = { owner: 'w', leaseMs: 30000 };
const dueAt = (now: string, limit = 10) => ({ now, limit, ...lease });

beforeAll(async () => {
  if (live) database = await startDisposablePostgres();
}, 60000);
beforeEach(async () => {
  if (!live) return;
  sql = openSql(database.url);
  pools.push(sql);
  await dropSchedulerSchema(sql);
  await rowClaimReady(sql);
  await switchSchedulerOwner(sql, 'legacy', 'rowclaim');
  port = createRowClaimSchedulePort(sql);
});
afterAll(async () => {
  if (!live) return;
  await Promise.all(pools.map((p) => p.end({ timeout: 1 })));
  await database.stop();
});

const runsOf = (ids: string[]) =>
  sql<
    { schedule_id: string; fire_at: Date }[]
  >`select schedule_id, fire_at from schedule_runs where schedule_id in (select jsonb_array_elements_text(${sql.json(ids)})::uuid)`;

describe.skipIf(!live)('row-claim adapter satisfies the shared schedule contract', () => {
  schedulePortContract(() => port);
});

describe.skipIf(!live)('concurrent dispatchers claim each slot exactly once', () => {
  test.each([2, 4])(
    '%i dispatchers, 25 repetitions, one occurrence per slot',
    async (n) => {
      const dispatchers = Array.from({ length: n }, () => createRowClaimSchedulePort(pool()));
      for (let rep = 0; rep < 25; rep += 1) {
        const specs = Array.from({ length: 12 }, () => scheduleFixture());
        for (const spec of specs) await port.create(spec, 'alice', T0);
        const ids = specs.map((s) => s.id);
        const results = await Promise.all(
          dispatchers.map(async (d) => {
            const mine = [];
            for (let i = 0; i < 20; i += 1) mine.push(...(await d.claimDue(dueAt(T1, 3))));
            return mine;
          }),
        );
        const claimed = results.flat().filter((r) => ids.includes(r.scheduleId));
        const rows = await runsOf(ids);
        expect(claimed).toHaveLength(12);
        expect(new Set(claimed.map((r) => r.id)).size).toBe(12);
        expect(rows).toHaveLength(12);
        expect(new Set(rows.map((r) => `${r.schedule_id}${r.fire_at.toISOString()}`)).size).toBe(
          12,
        );
        expect(await port.claimDue(dueAt(T1))).toEqual([]);
      }
    },
    120000,
  );

  test('a claimed slot is never re-claimed by the explicit claim path', async () => {
    const spec = scheduleFixture();
    await port.create(spec, 'alice', T0);
    const [run] = await port.claimDue(dueAt(T1));
    expect(run.id).toBe(scheduleRunId(spec.id, T1));
    const again = { scheduleId: spec.id, fireAt: T1, now: T1, event: null, ...lease };
    expect(await createRowClaimSchedulePort(pool()).claim(again)).toBeUndefined();
    expect(await port.runs(spec.id)).toHaveLength(1);
  });
});

describe.skipIf(!live)('a schedule edit at due time cannot create a second occurrence', () => {
  test('pause racing claimDue, 25 repetitions', async () => {
    const claimer = createRowClaimSchedulePort(pool());
    const editor = createRowClaimSchedulePort(pool());
    for (let rep = 0; rep < 25; rep += 1) {
      const spec = scheduleFixture();
      await port.create(spec, 'alice', T0);
      await Promise.all([
        claimer.claimDue(dueAt(T1)),
        editor.change('alice', spec.id, 1, 'pause', T1),
      ]);
      await editor.change('alice', spec.id, 2, 'resume', T1);
      await claimer.claimDue(dueAt('2026-10-14T10:01:30.000Z'));
      await claimer.claimDue(dueAt('2026-10-14T10:02:00.000Z'));
      const slotRuns = (await port.runs(spec.id)).filter((r) => r.fireAt === T1);
      expect(slotRuns.length).toBeLessThanOrEqual(1);
      if (slotRuns.length === 1) expect(slotRuns[0].id).toBe(scheduleRunId(spec.id, T1));
      expect((await runsOf([spec.id])).length).toBeLessThanOrEqual(2);
    }
  }, 60000);

  test('revision is stored beside the occurrence, not in its identity', async () => {
    const spec = scheduleFixture();
    await port.create(spec, 'alice', T0);
    await port.change('alice', spec.id, 1, 'pause', T0);
    await port.change('alice', spec.id, 2, 'resume', T0);
    const [run] = await port.claimDue(dueAt(T1));
    expect(run.id).toBe(scheduleRunId(spec.id, T1));
    expect(Object.keys(run)).not.toContain('revision');
    expect((await port.read('alice', spec.id))?.revision).toBe(3);
  });
});

describe.skipIf(!live)('catch-up, skip, resume and DST parity through claimDue', () => {
  const cron = (expression: string, over: Partial<ScheduleSpec> = {}) =>
    scheduleFixture({ timing: { kind: 'cron', expression }, ...over });

  test('catch-up-once claims only the latest missed slot', async () => {
    const spec = scheduleFixture();
    await port.create(spec, 'alice', T0);
    const claimed = await port.claimDue(dueAt('2026-10-14T10:10:05.000Z'));
    expect(claimed.map((r) => r.fireAt)).toEqual(['2026-10-14T10:10:00.000Z']);
    expect(await port.claimDue(dueAt('2026-10-14T10:10:30.000Z'))).toEqual([]);
    expect(await port.runs(spec.id)).toHaveLength(1);
  });

  test('skip drops a slot that is a minute or more late and keeps the schedule alive', async () => {
    const spec = scheduleFixture({
      timing: { kind: 'interval', everySeconds: 3600, anchor: T0 },
      misfire: 'skip',
    });
    await port.create(spec, 'alice', T0);
    expect(await port.claimDue(dueAt('2026-10-14T11:01:00.000Z'))).toEqual([]);
    const next = await port.claimDue(dueAt('2026-10-14T12:00:30.000Z'));
    expect(next.map((r) => r.fireAt)).toEqual(['2026-10-14T12:00:00.000Z']);
  });

  test('paused slots are dropped on resume and the next slot fires once', async () => {
    const spec = scheduleFixture();
    await port.create(spec, 'alice', T0);
    await port.change('alice', spec.id, 1, 'pause', '2026-10-14T10:05:00.000Z');
    expect(await port.claimDue(dueAt('2026-10-14T10:10:00.000Z'))).toEqual([]);
    await port.change('alice', spec.id, 2, 'resume', '2026-10-14T10:10:00.000Z');
    expect(await port.claimDue(dueAt('2026-10-14T10:10:05.000Z'))).toEqual([]);
    const fired = await port.claimDue(dueAt('2026-10-14T10:11:00.000Z'));
    expect(fired.map((r) => r.fireAt)).toEqual(['2026-10-14T10:11:00.000Z']);
  });

  test('revoked and expired schedules are parked and never claimed', async () => {
    const revoked = scheduleFixture();
    const expiring = scheduleFixture({ expiresAt: '2026-10-14T10:00:30.000Z' });
    await port.create(revoked, 'alice', T0);
    await port.create(expiring, 'alice', T0);
    await port.change('alice', revoked.id, 1, 'revoke', T0);
    expect(await port.claimDue(dueAt(T1))).toEqual([]);
    const due = await sql`select count(*)::int as n from schedules where next_due is not null`;
    expect(due[0].n).toBe(0);
  });

  test('fall-back repeats 01:30 as two distinct UTC slots with distinct run ids', async () => {
    const spec = cron('30 1 * * *', {
      timezone: 'America/New_York',
      expiresAt: '2026-11-03T00:00:00.000Z',
    });
    await port.create(spec, 'alice', '2026-11-01T05:00:00.000Z');
    const first = await port.claimDue(dueAt('2026-11-01T05:30:00.000Z'));
    const second = await port.claimDue(dueAt('2026-11-01T06:30:00.000Z'));
    expect([first[0]?.fireAt, second[0]?.fireAt]).toEqual([
      '2026-11-01T05:30:00.000Z',
      '2026-11-01T06:30:00.000Z',
    ]);
    expect(first[0].id).not.toBe(second[0].id);
  });

  test('spring-forward 02:30 has no slot that day and fires the next', async () => {
    const spec = cron('30 2 * * *', {
      timezone: 'America/New_York',
      expiresAt: '2026-03-12T00:00:00.000Z',
    });
    await port.create(spec, 'alice', '2026-03-08T05:00:00.000Z');
    for (const now of ['2026-03-08T07:30:00.000Z', '2026-03-08T12:00:00.000Z'])
      expect(await port.claimDue(dueAt(now))).toEqual([]);
    const next = await port.claimDue(dueAt('2026-03-09T06:30:00.000Z'));
    expect(next.map((r) => r.fireAt)).toEqual(['2026-03-09T06:30:00.000Z']);
  });

  test('event-only schedules get no due row', async () => {
    const { eventTriggerFixture } = await import('../scheduling/test-fixtures.js');
    const spec = scheduleFixture();
    await port.create(spec, 'alice', T0, eventTriggerFixture(spec.id));
    expect(await port.claimDue(dueAt(T1))).toEqual([]);
  });

  test('the scheduler resume characterization holds on the row-claim store', async () => {
    const f = await schedulerFixture();
    const scheduler = createScheduler({ ...f.deps, store: port });
    await scheduler.create(f.spec, 'alice');
    await scheduler.change('alice', f.spec.id, 1, 'pause');
    f.clock.advance(10 * 60000);
    await scheduler.tick();
    expect(await port.runs(f.spec.id)).toEqual([]);
    await scheduler.change('alice', f.spec.id, 2, 'resume');
    expect((await port.read('alice', f.spec.id))?.cursor).toBe(f.clock.now().toISOString());
    f.clock.advance(65000);
    await scheduler.tick();
    expect(await port.runs(f.spec.id)).toMatchObject([{ fireAt: '2026-10-14T10:11:00.000Z' }]);
    await expect(scheduler.change('alice', f.spec.id, 9, 'pause')).rejects.toThrow(
      ScheduleConflict,
    );
  });
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

describe.skipIf(!live)('no global lock on independent schedules', () => {
  test('advisory lock 7013 held elsewhere does not stall claims or edits', async () => {
    const spec = scheduleFixture();
    await port.create(spec, 'alice', T0);
    const free = await hold((tx) => tx`select pg_advisory_xact_lock(7013)`);
    try {
      const started = Date.now();
      expect(await port.claimDue(dueAt(T1))).toHaveLength(1);
      await port.change('alice', spec.id, 1, 'pause', T1);
      expect(Date.now() - started).toBeLessThan(1500);
    } finally {
      await free();
    }
  });

  test('a locked schedule is skipped, others proceed, and a bounded wait gives up', async () => {
    const a = scheduleFixture();
    const b = scheduleFixture();
    await port.create(a, 'alice', T0);
    await port.create(b, 'alice', T0);
    const free = await hold(
      (tx) => tx`select 1 from schedules where id = ${a.id}::uuid for update`,
    );
    try {
      const claimed = await port.claimDue(dueAt(T1));
      expect(claimed.map((r) => r.scheduleId)).toEqual([b.id]);
      await port.change('alice', b.id, 1, 'pause', T1);
      const impatient = createRowClaimSchedulePort(pool(), { lockTimeoutMs: 200 });
      const started = Date.now();
      await expect(impatient.change('alice', a.id, 1, 'pause', T1)).rejects.toThrow('busy');
      expect(Date.now() - started).toBeLessThan(3000);
    } finally {
      await free();
    }
    expect((await port.claimDue(dueAt(T1))).map((r) => r.scheduleId)).toEqual([a.id]);
  });
});
