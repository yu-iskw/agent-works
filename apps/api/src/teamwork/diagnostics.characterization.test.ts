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
import { applyGraphMigration } from './graph-migration.js';
import { createModelGate } from './model.js';
import { createScriptedModel } from './scripted-model.js';
import { createFixtureSources } from './sources/fixture.js';

import type { Deps, Member } from './context.js';
import type { SourcePort } from './sources/port.js';
import type { DisposablePostgres } from '../ledger/disposable-postgres.js';

/** AGT-04: the diagnostics path rechecks membership and audits per source, like the gateway. */
const member: Member = { sub: 'local-test:alice', email: 'alice@local.test' };
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
  await applyGraphMigration(sql);
}, 60_000);

afterAll(async () => {
  await sql.end({ timeout: 1 });
  await database?.stop();
});

beforeEach(async () => {
  reads = 0;
  await sql`truncate tw_audit, tw_connections, tw_installations cascade`;
});

describe('checkSources', () => {
  it('denies a non-member before any provider read and audits the denial', async () => {
    const d = segment();
    expect(d.config.members.has(outsider.email), 'carol is not a segment member').toBe(false);
    await expect(checkSources(d, outsider)).rejects.toMatchObject({ code: 'not_entitled' });
    expect(reads).toBe(0);
    const rows = await sql<{ action: string; outcome: string }[]>`
      select action, outcome from tw_audit order by id`;
    expect(rows).toEqual([{ action: 'gateway.denied', outcome: 'not_entitled' }]);
  });

  it('fails closed and retryable when the directory cannot answer, with no provider read', async () => {
    const d: Deps = {
      ...segment(),
      directory: { isMember: () => Promise.reject(new Error('503')) },
    };
    await expect(checkSources(d, member)).rejects.toMatchObject({
      code: 'resolution_unavailable',
      retryable: true,
    });
    expect(reads).toBe(0);
  });

  it('stops reading for a member removed in the directory', async () => {
    const d: Deps = { ...segment(), directory: { isMember: () => Promise.resolve(false) } };
    await expect(checkSources(d, member)).rejects.toMatchObject({ code: 'not_entitled' });
    expect(reads).toBe(0);
  });

  it('reads each source for a member and audits every source under the member', async () => {
    const checks = await checkSources(segment(), member);
    expect(checks).toHaveLength(5);
    expect(reads, 'one provider read per non-file source').toBe(5);
    const rows = await sql<{ action: string; owner_sub: string }[]>`
      select action, owner_sub from tw_audit order by id`;
    expect(rows.filter((row) => row.action === 'sources.check.source')).toHaveLength(5);
    expect(rows.filter((row) => row.action === 'sources.check')).toHaveLength(1);
    expect(new Set(rows.map((row) => row.owner_sub))).toEqual(new Set([member.sub]));
  });

  it('skips a source the segment disabled, audits it as not_allowed and makes no read for it', async () => {
    const d = segment();
    await sql`insert into tw_installations (item_kind, item_id, version, capabilities,
      desired_state, observed_state, updated_by, updated_at)
      values ('connector', 'github', '1.0.0', '[]'::jsonb, 'disabled', 'not_required', 'admin', now())`;
    const checks = await checkSources(d, member);
    const github = checks.filter((check) => check.source.startsWith('github'));
    expect(github.map((check) => check.status)).toEqual(['not_allowed', 'not_allowed']);
    expect(reads).toBe(3);
    const rows = await sql<{ outcome: string }[]>`
      select outcome from tw_audit where action = 'sources.check.source' and outcome = 'not_allowed'`;
    expect(rows).toHaveLength(2);
  });
});
