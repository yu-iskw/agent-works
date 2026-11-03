import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createSealer } from '@agent-works/domain/sealer';
import postgres from 'postgres';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { startDisposablePostgres } from '../ledger/disposable-postgres.js';
import { applyWorkbenchMigration } from '../workbench/migration.js';

import { readSegmentConfig } from './config.js';
import { checkSources } from './diagnostics.js';
import { createModelGate } from './model.js';
import { createScriptedModel } from './scripted-model.js';
import { createFixtureSources } from './sources/fixture.js';

import type { Deps, Member } from './context.js';
import type { SourcePort } from './sources/port.js';
import type { DisposablePostgres } from '../ledger/disposable-postgres.js';

/**
 * AGT-00 characterization of the diagnostics path that bypasses the segment gateway
 * (`auth-01-teamwork-gateway-followup.md`). These assertions describe today's gap. When the
 * follow-up routes `checkSources` through `invoke`, update them in the same change.
 */
const outsider: Member = { sub: 'local-test:carol', email: 'carol@local.test' };
const root = new URL('../../../../', import.meta.url).pathname;

let database: DisposablePostgres | undefined;
let sql: postgres.Sql;
let reads = 0;

function segment(): Deps {
  const config = readSegmentConfig({
    AW_SEGMENT_ID: 'alpha',
    AW_IDENTITY: 'local-test',
    AW_SOURCE_MODE: 'fixture',
    AW_LOCAL_TEST_MEMBERS: 'alice@local.test',
    AW_KEY_DIR: mkdtempSync(join(tmpdir(), 'tw-keys-')),
  });
  const fixture = createFixtureSources({ root, segment: 'alpha', sql, faults: false });
  const sources: SourcePort = {
    mode: fixture.mode,
    findPublished: (...args) => fixture.findPublished(...args),
    read(request) {
      reads += 1;
      return fixture.read(request);
    },
    publish: (request) => fixture.publish(request),
  };
  return {
    sql,
    config,
    gate: createModelGate({
      sql,
      segment: 'alpha',
      model: createScriptedModel(),
      limit: 10,
      now: () => new Date(),
      sleep: () => Promise.resolve(),
    }),
    sources,
    sealer: createSealer(Buffer.alloc(32, 1), 'test'),
    now: () => new Date(),
    newId: () => crypto.randomUUID(),
    fetch,
  };
}

beforeAll(async () => {
  database = await startDisposablePostgres();
  sql = postgres(database.url, { onnotice: () => undefined });
  await applyWorkbenchMigration(sql);
}, 60_000);

afterAll(async () => {
  await sql.end({ timeout: 1 });
  await database?.stop();
});

beforeEach(async () => {
  reads = 0;
  await sql`truncate tw_audit, tw_connections, tw_installations cascade`;
});

describe('checkSources today', () => {
  it('reads providers directly, without a membership recheck, and audits one aggregate row', async () => {
    const d = segment();
    expect(d.config.members.has(outsider.email), 'carol is not a segment member').toBe(false);
    const checks = await checkSources(d, outsider);
    expect(checks).toHaveLength(5);
    expect(reads, 'one provider read per non-file source, for a non-member').toBe(5);
    const rows = await sql<{ action: string }[]>`select action from tw_audit order by id`;
    expect(rows.map((row) => row.action)).toEqual(['sources.check']);
    expect(rows.some((row) => row.action.startsWith('gateway.'))).toBe(false);
  });
});
