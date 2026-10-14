import { execFileSync } from 'node:child_process';

import postgres from 'postgres';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { openSql, startDisposablePostgres } from '../ledger/disposable-postgres.js';
import { governanceContract } from '../ports/governance.contract.js';

import { requestDeletion, processDeletion } from './deletion-requests.js';
import { governanceReady } from './migration.js';
import { createPostgresGovernancePort } from './postgres.js';
import {
  CREATED,
  EXPIRED,
  governanceFixture,
  recordFixture,
  REQUEST_ID,
  SECRET,
} from './test-fixtures.js';

import type { DisposablePostgres } from '../ledger/disposable-postgres.js';
import type { GovernancePort } from '../ports/governance.js';
import type { Sql } from 'postgres';

function dockerAvailable(): boolean {
  try {
    execFileSync('docker', ['info'], { stdio: 'ignore', timeout: 3000 });
    return true;
  } catch {
    return false;
  }
}
const live = dockerAvailable();
let database: DisposablePostgres | undefined;
let sql: Sql | undefined;
let second: Sql | undefined;
let port: GovernancePort;
beforeAll(async () => {
  if (!live) return;
  database = await startDisposablePostgres();
  sql = openSql(database.url);
  await governanceReady(sql);
}, 60000);
beforeEach(async () => {
  if (!live) return;
  if (sql === undefined || database === undefined) throw new Error('postgres unavailable');
  await second?.end({ timeout: 1 });
  await sql`drop schema if exists restore cascade`;
  await sql`drop schema public cascade`;
  await sql`create schema public`;
  await sql.end({ timeout: 1 });
  sql = openSql(database.url);
  await governanceReady(sql);
  port = createPostgresGovernancePort(sql);
});
afterAll(async () => {
  await second?.end({ timeout: 1 });
  await sql?.end({ timeout: 1 });
  await database?.stop();
});
describe.skipIf(!live)('Postgres governance contract', () => {
  let created = 0;
  beforeEach(() => {
    created = 0;
  });
  governanceContract(() => {
    created += 1;
    if (created === 1) return port;
    // Restore contract uses a separate schema, faithfully representing a restored database.
    // Construction must be synchronous; lazy port initialization supplies a new pool.
    let ready: Promise<GovernancePort> | undefined;
    function restored(): Promise<GovernancePort> {
      ready ??= (async () => {
        if (sql === undefined || database === undefined) throw new Error('postgres unavailable');
        await sql`create schema restore`;
        second = postgres(database.url, {
          max: 1,
          connect_timeout: 2,
          ssl: false,
          fetch_types: false,
          connection: { search_path: 'restore' },
        });
        // A dedicated max=1 pool is needed for connection-local search_path.
        await governanceReady(second);
        return createPostgresGovernancePort(second);
      })();
      return ready;
    }
    return {
      snapshot: async () => (await restored()).snapshot(),
      transact: async (operation) => (await restored()).transact(operation),
    };
  });
  it('database evidence rejects updates, deletes and truncate', async () => {
    if (sql === undefined) throw new Error('postgres unavailable');
    await expect(sql`update governance_audit set payload = '{}'::jsonb`).rejects.toThrow(
      'append-only',
    );
    await expect(sql`delete from governance_legal_holds`).rejects.toThrow('append-only');
    await expect(sql`truncate governance_tombstones`).rejects.toThrow('append-only');
  });
  it('another pool reads durable encrypted rows', async () => {
    const { store } = await governanceFixture(port);
    await store.put(recordFixture(), SECRET);
    if (database === undefined) throw new Error('postgres unavailable');
    const reopened = openSql(database.url);
    try {
      const state = await createPostgresGovernancePort(reopened).snapshot();
      expect(state.artifacts).toHaveLength(1);
      expect(state.artifacts[0].record.createdAt).toBe(CREATED);
      expect(JSON.stringify(state)).not.toContain(SECRET);
    } finally {
      await reopened.end({ timeout: 1 });
    }
  });
  it('enforces required SQL projections and the encrypted envelope contract', async () => {
    if (sql === undefined) throw new Error('postgres unavailable');
    const { store } = await governanceFixture(port);
    await store.put(recordFixture(), SECRET);
    await expect(
      sql`insert into governance_artifacts (id, payload) values ('malformed', '{}'::jsonb)`,
    ).rejects.toThrow();
    await expect(
      sql`update governance_artifacts set payload = jsonb_set(payload, '{envelope}', '{}'::jsonb)`,
    ).rejects.toThrow();
    await expect(
      sql`update governance_artifacts set payload = jsonb_set(payload, '{record,classification}', '"SECRET"'::jsonb)`,
    ).rejects.toThrow();
    const state = await port.snapshot();
    expect(state.artifacts).toHaveLength(1);
    expect(state.artifacts[0].record.classification).toBe('RESTRICTED');
  });

  it('fences request identity, revision and terminal state through direct SQL', async () => {
    if (sql === undefined) throw new Error('postgres unavailable');
    await requestDeletion(
      port,
      { requestId: REQUEST_ID, subject: 'alice', reasonRef: 'privacy' },
      'officer',
      new Date(CREATED),
    );
    await expect(
      sql`update governance_deletion_requests set payload = jsonb_set(payload, '{subject}', '"bob"'::jsonb)`,
    ).rejects.toThrow('identity');
    await expect(
      sql`update governance_deletion_requests set payload = jsonb_set(payload, '{updatedAt}', '"2026-01-02T00:00:00.000Z"'::jsonb)`,
    ).rejects.toThrow('revision');
    await processDeletion(port, REQUEST_ID, 'officer', EXPIRED);
    await expect(
      sql`update governance_deletion_requests set payload = jsonb_set(payload, '{state}', '"REQUESTED"'::jsonb)`,
    ).rejects.toThrow('terminal');
    await expect(sql`delete from governance_deletion_requests`).rejects.toThrow('append-only');
    expect((await port.snapshot()).requests[0].state).toBe('PURGED');
  });

  it('coordinates repeated readiness calls across independent pools', async () => {
    if (database === undefined) throw new Error('postgres unavailable');
    const first = openSql(database.url);
    const other = openSql(database.url);
    try {
      await Promise.all([governanceReady(first), governanceReady(other), governanceReady(first)]);
      const rows = await first<
        { count: string }[]
      >`select count(*)::text as count from schema_migrations where name = '0012_data_governance.sql'`;
      expect(rows[0].count).toBe('1');
    } finally {
      await Promise.all([first.end({ timeout: 1 }), other.end({ timeout: 1 })]);
    }
  });
});
