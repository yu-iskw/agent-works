import { execFileSync } from 'node:child_process';

import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest';

import { openSql, startDisposablePostgres } from '../ledger/disposable-postgres.js';
import { createMemorySuspensionLedger } from '../ports/memory/suspension-ledger.js';
import { suspensionLedgerContract } from '../ports/suspension-ledger.contract.js';

import { createPostgresSuspensionLedger, suspensionLedgerReady } from './postgres.js';

import type { DisposablePostgres } from '../ledger/disposable-postgres.js';
import type { SuspensionLedger } from '../ports/suspension-ledger.js';
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
let ledger: SuspensionLedger;
beforeAll(async () => {
  if (live) {
    database = await startDisposablePostgres();
    sql = openSql(database.url);
  }
}, 60_000);
beforeEach(async () => {
  if (sql !== undefined) {
    // Disposable test database only; append-only triggers deliberately reject truncate.
    await sql`drop table if exists suspension_states, capability_version_states, suspension_history cascade`;
    await sql`drop function if exists reject_suspension_rewrite()`;
    await sql`drop table if exists schema_migrations`;
    const fresh = openSql(database?.url ?? '');
    await suspensionLedgerReady(fresh);
    ledger = createPostgresSuspensionLedger(fresh);
    await sql.end({ timeout: 1 });
    sql = fresh;
  } else ledger = createMemorySuspensionLedger();
});
afterAll(async () => {
  await sql?.end({ timeout: 1 });
  await database?.stop();
});
describe('Postgres adapter contract (memory fallback when Docker unavailable)', () => {
  suspensionLedgerContract(() => ledger);
});
test.skipIf(!live)('database blocks destructive updates and truncation', async () => {
  if (sql === undefined) throw new Error('postgres unavailable');
  await expect(sql`update suspension_states set revision = 2`).rejects.toThrow('append-only');
  await expect(sql`delete from capability_version_states`).rejects.toThrow('append-only');
  await expect(sql`truncate suspension_history`).rejects.toThrow('append-only');
});

test.skipIf(!live)('audit insert failure rolls back the corresponding state revision', async () => {
  if (sql === undefined) throw new Error('postgres unavailable');
  await sql`alter table suspension_history add constraint force_test_rollback check (payload->>'actorSub' <> 'rollback-actor')`;
  const input = {
    kind: 'suspension' as const,
    command: {
      commandId: '00000000-0000-4000-8000-000000000009',
      action: 'suspend' as const,
      target: { scope: 'global' as const, id: '*' as const, version: null },
      reason: 'Rollback test',
      expiresAt: null,
      expectedRevision: 0,
    },
  };
  await expect(ledger.change(input, 'rollback-actor', new Date())).rejects.toThrow();
  expect(await ledger.snapshot()).toEqual({ suspensions: [], versions: [] });
  expect(await ledger.history()).toEqual([]);
});

test.skipIf(!live)(
  'a new pool reads committed state and identical retries after restart',
  async () => {
    if (database === undefined) throw new Error('postgres unavailable');
    const input = {
      kind: 'suspension' as const,
      command: {
        commandId: '00000000-0000-4000-8000-000000000010',
        action: 'suspend' as const,
        target: { scope: 'global' as const, id: '*' as const, version: null },
        reason: 'Restart test',
        expiresAt: null,
        expectedRevision: 0,
      },
    };
    const first = await ledger.change(input, 'operator', new Date());
    const secondSql = openSql(database.url);
    try {
      const reopened = createPostgresSuspensionLedger(secondSql);
      expect((await reopened.snapshot()).suspensions).toEqual([first.record]);
      expect(await reopened.change(input, 'operator', new Date())).toEqual({
        ...first,
        replay: true,
      });
      expect(await reopened.history()).toHaveLength(1);
    } finally {
      await secondSql.end({ timeout: 1 });
    }
  },
);
