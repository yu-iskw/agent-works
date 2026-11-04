import { execFileSync } from 'node:child_process';

import { scheduleRunId } from '@agent-works/domain';
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest';

import { startDisposablePostgres, openSql } from '../ledger/disposable-postgres.js';
import { createPostgresSchedulePort } from '../ports/schedule-postgres.js';

import { schedulesReady } from './migration.js';
import { scheduleFixture } from './test-fixtures.js';

import type { DisposablePostgres } from '../ledger/disposable-postgres.js';
import type { ClaimRun } from '../ports/schedule-port.js';
import type { Sql } from 'postgres';

function available(): boolean {
  try {
    execFileSync('docker', ['info'], { stdio: 'ignore', timeout: 3000 });
    return true;
  } catch {
    return false;
  }
}
const live = available();
const T0 = '2026-10-14T10:00:00.000Z';
const SLOT = '2026-10-14T10:01:00.000Z';
let database: DisposablePostgres;
let sql: Sql;
const pools: Sql[] = [];
const claimOf = (scheduleId: string, owner: string): ClaimRun => ({
  scheduleId,
  fireAt: SLOT,
  owner,
  now: SLOT,
  leaseMs: 30000,
  event: null,
});
const portOn = (pool: Sql) => createPostgresSchedulePort(pool);

beforeAll(async () => {
  if (!live) return;
  database = await startDisposablePostgres();
  sql = openSql(database.url);
}, 60000);
beforeEach(async () => {
  if (!live) return;
  await sql`drop table if exists schedule_audit,received_events,schedule_runs,event_triggers,schedules cascade`;
  await sql`drop function if exists reject_schedule_audit_rewrite()`;
  await sql`drop table if exists schema_migrations`;
  const fresh = openSql(database.url);
  await sql.end({ timeout: 1 });
  sql = fresh;
  await schedulesReady(sql);
});
afterAll(async () => {
  if (!live) return;
  await Promise.all(pools.map((p) => p.end({ timeout: 1 })));
  await sql.end({ timeout: 1 });
  await database.stop();
});
const extraPool = () => {
  const pool = openSql(database.url);
  pools.push(pool);
  return pool;
};
const slotRows = () =>
  sql<{ id: string; payload: Record<string, unknown> }[]>`select id, payload from schedule_runs`;

describe.skipIf(!live)('DUR-01 on real Postgres: one run per canonical occurrence', () => {
  test('eight independent pools racing one slot produce exactly one winner and one row', async () => {
    const spec = scheduleFixture();
    await portOn(sql).create(spec, 'alice', T0);
    const ports = Array.from({ length: 8 }, () => portOn(extraPool()));
    const claims = await Promise.all(ports.map((p, i) => p.claim(claimOf(spec.id, `w${i}`))));
    expect(claims.filter((c) => c !== undefined)).toHaveLength(1);
    const rows = await slotRows();
    expect(rows.map((r) => r.id)).toEqual([scheduleRunId(spec.id, SLOT)]);
  });

  test('the database itself refuses a second row for the slot even under a different id', async () => {
    const spec = scheduleFixture();
    await portOn(sql).create(spec, 'alice', T0);
    const run = await portOn(sql).claim(claimOf(spec.id, 'a'));
    const revisionKeyed = 'f'.repeat(64);
    await expect(
      sql`insert into schedule_runs(id,schedule_id,fire_at,event_key,status,fence,lease_until,task_id,payload) values(${revisionKeyed},${spec.id},${SLOT},null,'dispatching',1,${SLOT},null,${sql.json({ ...run })})`,
    ).rejects.toMatchObject({ constraint_name: 'schedule_run_slot' });
    expect(await slotRows()).toHaveLength(1);
  });

  test('event runs are a separate uniqueness domain: same instant, distinct keys, no clash with timed', async () => {
    const spec = scheduleFixture();
    await portOn(sql).create(spec, 'alice', T0);
    await portOn(sql).claim(claimOf(spec.id, 'a'));
    const insert = (id: string, key: string) =>
      sql`insert into schedule_runs(id,schedule_id,fire_at,event_key,status,fence,lease_until,task_id,payload) values(${id},${spec.id},${SLOT},${key},'dispatching',1,${SLOT},null,${sql.json({})})`;
    await insert('1'.repeat(64), 'e1');
    await insert('2'.repeat(64), 'e2');
    await expect(insert('3'.repeat(64), 'e1')).rejects.toMatchObject({
      constraint_name: 'schedule_run_event',
    });
    expect(await slotRows()).toHaveLength(3);
  });
});

describe.skipIf(!live)('schedule edits cannot fork an occurrence', () => {
  test('pause/resume racing the due-time claim never yields a second run for the slot', async () => {
    const spec = scheduleFixture();
    await portOn(sql).create(spec, 'alice', T0);
    const claimer = portOn(extraPool());
    const editor = portOn(extraPool());
    const [first] = await Promise.all([
      claimer.claim(claimOf(spec.id, 'a')),
      editor.change('alice', spec.id, 1, 'pause', SLOT),
    ]);
    await editor.change('alice', spec.id, 2, 'resume', SLOT);
    const second = await claimer.claim(claimOf(spec.id, 'b'));
    const rows = await slotRows();
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe(scheduleRunId(spec.id, SLOT));
    expect([first, second].filter((v) => v !== undefined)).toHaveLength(1);
    expect((await editor.read('alice', spec.id))?.revision).toBe(3);
  });

  test('after the revision moves on, re-claiming the claimed slot reuses it', async () => {
    const spec = scheduleFixture();
    const port = portOn(sql);
    await port.create(spec, 'alice', T0);
    const run = await port.claim(claimOf(spec.id, 'a'));
    await port.change('alice', spec.id, 1, 'pause', SLOT);
    await port.change('alice', spec.id, 2, 'resume', SLOT);
    expect(await portOn(extraPool()).claim(claimOf(spec.id, 'b'))).toBeUndefined();
    const rows = await slotRows();
    expect(rows.map((r) => r.id)).toEqual([run?.id]);
    expect(Object.keys(rows[0].payload)).not.toContain('revision');
  });

  test('a stale-revision edit loses and leaves schedule and runs untouched', async () => {
    const spec = scheduleFixture();
    const port = portOn(sql);
    await port.create(spec, 'alice', T0);
    await port.change('alice', spec.id, 1, 'pause', SLOT);
    await expect(port.change('alice', spec.id, 1, 'resume', SLOT)).rejects.toThrow('stale');
    expect((await port.read('alice', spec.id))?.state).toBe('paused');
    expect(await slotRows()).toHaveLength(0);
  });
});
