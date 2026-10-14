import { execFileSync } from 'node:child_process';

import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest';

import { startDisposablePostgres, openSql } from '../ledger/disposable-postgres.js';
import { schedulesReady } from '../scheduling/migration.js';
import { scheduleFixture } from '../scheduling/test-fixtures.js';

import { schedulePortContract } from './schedule-port.contract.js';
import { createPostgresSchedulePort } from './schedule-postgres.js';

import type { SchedulePort } from './schedule-port.js';
import type { DisposablePostgres } from '../ledger/disposable-postgres.js';
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
let database: DisposablePostgres;
let sql: Sql;
let port: SchedulePort;
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
  port = createPostgresSchedulePort(sql);
});
afterAll(async () => {
  if (live) {
    await sql.end({ timeout: 1 });
    await database.stop();
  }
});
describe.skipIf(!live)('Postgres schedule contract (requires disposable Postgres)', () => {
  schedulePortContract(() => port);
});
test.skipIf(!live)('new pool recovers schedules, slots, and audit after restart', async () => {
  const spec = scheduleFixture();
  const at = '2026-10-14T10:00:00.000Z';
  const row = await port.create(spec, 'alice', at);
  const other = openSql(database.url);
  try {
    const reopened = createPostgresSchedulePort(other);
    expect(await reopened.read('alice', spec.id)).toEqual(row);
    expect(await reopened.create(spec, 'alice', at)).toEqual(row);
    expect(await reopened.history('alice')).toHaveLength(1);
  } finally {
    await other.end({ timeout: 1 });
  }
});
test.skipIf(!live)('audit insertion failure rolls back schedule creation', async () => {
  await sql`alter table schedule_audit add constraint reject_test_actor check (payload->>'actorSub' <> 'alice')`;
  await expect(
    port.create(scheduleFixture(), 'alice', '2026-10-14T10:00:00.000Z'),
  ).rejects.toThrow();
  expect(await port.all()).toEqual([]);
});
test.skipIf(!live)('database rejects audit rewrite, delete, and truncate', async () => {
  await expect(sql`update schedule_audit set payload='{}'::jsonb`).rejects.toThrow('append-only');
  await expect(sql`delete from schedule_audit`).rejects.toThrow('append-only');
  await expect(sql`truncate schedule_audit`).rejects.toThrow('append-only');
});
test.skipIf(!live)('two independent pools compete for the same fire slot', async () => {
  const spec = scheduleFixture();
  await port.create(spec, 'alice', '2026-10-14T10:00:00.000Z');
  const other = openSql(database.url);
  try {
    const reopened = createPostgresSchedulePort(other);
    const input = {
      scheduleId: spec.id,
      fireAt: '2026-10-14T10:01:00.000Z',
      now: '2026-10-14T10:01:00.000Z',
      leaseMs: 30000,
      event: null,
    };
    const claims = await Promise.all([
      port.claim({ ...input, owner: 'a' }),
      reopened.claim({ ...input, owner: 'b' }),
    ]);
    expect(claims.filter((v) => v !== undefined)).toHaveLength(1);
    expect(await reopened.runs(spec.id)).toHaveLength(1);
  } finally {
    await other.end({ timeout: 1 });
  }
});
