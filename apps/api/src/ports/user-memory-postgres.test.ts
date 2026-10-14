import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';

import postgres from 'postgres';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { requestDeletion, processDeletion } from '../governance/deletion-requests.js';
import { createPostgresGovernancePort } from '../governance/postgres.js';
import { openSql, startDisposablePostgres } from '../ledger/disposable-postgres.js';
import { changeConsent } from '../memory/consent.js';
import { governUserMemory } from '../memory/governance.js';
import { reviseMemory } from '../memory/manage.js';
import { userMemoryReady } from '../memory/migration.js';
import { restoreUserMemory } from '../memory/restore.js';
import { memoryFixture, aliceScope, MEMORY_AT } from '../memory/test-fixtures.js';

import { createPostgresUserMemoryStore } from './user-memory-postgres.js';
import { userMemoryContract } from './user-memory.contract.js';

import type { MemoryStore } from './user-memory.js';
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
let store: MemoryStore;
beforeAll(async () => {
  if (!live) return;
  database = await startDisposablePostgres();
  sql = openSql(database.url);
}, 60000);
beforeEach(async () => {
  if (!live) return;
  await sql`drop schema public cascade`;
  await sql`create schema public`;
  await sql.end({ timeout: 1 });
  sql = openSql(database.url);
  await userMemoryReady(sql);
  store = createPostgresUserMemoryStore(sql);
});
afterAll(async () => {
  if (live) {
    await sql.end({ timeout: 1 });
    await database.stop();
  }
});
describe.skipIf(!live)('Postgres user memory (offline disposable cluster)', () => {
  userMemoryContract(() => store);
  it('recovers current and revision history from a new pool', async () => {
    const f = memoryFixture(store);
    await f.enable();
    const item = await f.put();
    await reviseMemory(
      store,
      f.policy,
      aliceScope,
      { id: item.id, agent: item.agent, revision: 1, text: 'changed' },
      new Date(MEMORY_AT),
    );
    const other = openSql(database.url);
    try {
      const reopened = createPostgresUserMemoryStore(other);
      expect((await reopened.transaction((state) => state.items))[0].revision).toBe(2);
      expect(await reopened.transaction((state) => state.history)).toHaveLength(2);
    } finally {
      await other.end({ timeout: 1 });
    }
  });
  it('persists restore consent removals across pool reloads without deleting other scopes', async () => {
    const f = memoryFixture(store);
    const evidence = await store.transaction((state) => state);
    await f.enable();
    const otherScopes = [
      { ...aliceScope, owner: 'bob' },
      { ...aliceScope, tenant: 'tenant-b' },
    ];
    for (const scope of otherScopes) {
      evidence.consents.push(
        await changeConsent(
          store,
          scope,
          { enabled: true, revision: 0, noticeVersion: 'memory-v1' },
          new Date(MEMORY_AT),
        ),
      );
    }
    await f.put();
    expect(await restoreUserMemory(store, evidence, new Date(MEMORY_AT))).toBe(1);
    const other = openSql(database.url);
    try {
      const reopened = createPostgresUserMemoryStore(other);
      const reloaded = memoryFixture(reopened);
      expect(await reopened.transaction((state) => state.consents)).toEqual(evidence.consents);
      await expect(reloaded.put()).rejects.toThrow('denied');
      expect(await reopened.transaction((state) => state.items)).toEqual([]);
      expect(await reopened.transaction((state) => state.history)).toEqual([]);
    } finally {
      await other.end({ timeout: 1 });
    }
  });
  it('rejects direct history rewriting and audit deletion', async () => {
    const f = memoryFixture(store);
    await f.enable();
    await f.put();
    await expect(sql`update user_memory_history set payload='{}'::jsonb`).rejects.toThrow(
      'append-only',
    );
    await expect(sql`delete from user_memory_audit`).rejects.toThrow('immutable');
  });
  it('rolls back payload writes when audit insertion fails', async () => {
    const f = memoryFixture(store);
    await f.enable();
    await sql`alter table user_memory_audit add constraint reject_proposal check (payload->>'action' <> 'propose')`;
    await expect(f.put()).rejects.toThrow();
    expect(await store.transaction((state) => state.items)).toEqual([]);
    expect(await store.transaction((state) => state.history)).toEqual([]);
  });
});

describe.skipIf(!live)('governance and memory share a one-connection pool', () => {
  function composed() {
    const pool = postgres(database.url, {
      max: 1,
      connect_timeout: 2,
      ssl: false,
      fetch_types: false,
    });
    const governance = createPostgresGovernancePort(pool);
    const raw = createPostgresUserMemoryStore(pool);
    const governed = governUserMemory(raw, governance, () => new Date(MEMORY_AT));
    return { pool, governance, raw, ...memoryFixture(governed) };
  }
  it('initializes memory inside governance and serves concurrent transactions', async () => {
    // Remove the eagerly initialized migration to exercise cold nested startup.
    await sql`drop schema public cascade`;
    await sql`create schema public`;
    const f = composed();
    try {
      await f.enable();
      const item = await f.put();
      const readItems = () => f.store.transaction((state) => state.items);
      const results = await Promise.all(Array.from({ length: 4 }, readItems));
      for (const result of results) expect(result).toEqual([item]);
    } finally {
      await f.pool.end({ timeout: 1 });
    }
  }, 10000);
  it('deletion fanout commits both stores on the shared connection', async () => {
    const f = composed();
    try {
      await f.enable();
      await f.put();
      const requestId = randomUUID();
      await requestDeletion(
        f.governance,
        { requestId, subject: 'alice', reasonRef: 'case' },
        'officer',
        new Date(MEMORY_AT),
      );
      expect(
        (await processDeletion(f.governance, requestId, 'officer', new Date(MEMORY_AT))).state,
      ).toBe('PURGED');
      expect(await f.raw.transaction((state) => state.items)).toEqual([]);
      expect(await f.raw.transaction((state) => state.history)).toEqual([]);
    } finally {
      await f.pool.end({ timeout: 1 });
    }
  }, 10000);
  it('rolls memory writes back when the outer governance transaction fails', async () => {
    const f = composed();
    try {
      await f.enable();
      await expect(
        f.governance.transact(async () => {
          await f.put();
          throw new Error('outer rollback');
        }),
      ).rejects.toThrow('outer rollback');
      expect(await f.raw.transaction((state) => state.items)).toEqual([]);
      expect(await f.raw.transaction((state) => state.history)).toEqual([]);
    } finally {
      await f.pool.end({ timeout: 1 });
    }
  }, 10000);
});
