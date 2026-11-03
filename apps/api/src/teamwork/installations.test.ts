import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { startDisposablePostgres } from '../ledger/disposable-postgres.js';
import { applyWorkbenchMigration } from '../workbench/migration.js';

import { readSegmentConfig } from './config.js';
import {
  BOOTSTRAP_ACTOR,
  bootstrapInstallations,
  getInstallation,
  segmentCapabilities,
  updateInstallation,
} from './installations.js';

import type { Deps } from './context.js';
import type { Capability } from '@agent-works/domain/teamwork';

type Segment = { readonly deps: Deps; readonly sql: postgres.Sql; stop(): Promise<void> };

async function segment(
  id: string,
  capabilities: readonly Capability[],
): Promise<Segment & { database: Awaited<ReturnType<typeof startDisposablePostgres>> }> {
  const database = await startDisposablePostgres();
  const sql = postgres(database.url, { onnotice: () => undefined });
  await applyWorkbenchMigration(sql);
  const base = readSegmentConfig({
    AW_SEGMENT_ID: id,
    AW_IDENTITY: 'local-test',
    AW_SOURCE_MODE: 'fixture',
    AW_LOCAL_TEST_MEMBERS: 'alice@local.test',
    AW_KEY_DIR: mkdtempSync(join(tmpdir(), 'tw-keys-')),
  });
  const deps = {
    sql,
    config: { ...base, capabilities: new Set(capabilities) },
    now: () => new Date(),
  } as unknown as Deps;
  return {
    deps,
    sql,
    database,
    stop: async () => {
      await sql.end({ timeout: 1 });
      await database.stop();
    },
  };
}

const all: readonly Capability[] = [
  'drive.read',
  'docs.publish',
  'bigquery.query',
  'github.read',
  'files.read',
];

let alpha: Awaited<ReturnType<typeof segment>>;
let beta: Awaited<ReturnType<typeof segment>>;

beforeAll(async () => {
  alpha = await segment('alpha', all);
  beta = await segment('beta', all);
}, 120_000);

afterAll(async () => {
  await alpha.stop();
  await beta.stop();
});

const sorted = (set: ReadonlySet<Capability>) => [...set].sort((a, b) => a.localeCompare(b));

describe('installations', () => {
  it('bootstraps one audited row per env-allowed provider and is idempotent', async () => {
    await bootstrapInstallations(alpha.deps);
    await bootstrapInstallations(alpha.deps);
    const rows = await alpha.sql<{ item_id: string; updated_by: string }[]>`
      select item_id, updated_by from tw_installations order by item_id
    `;
    expect(rows.map((row) => [row.item_id, row.updated_by])).toEqual([
      ['github', BOOTSTRAP_ACTOR],
      ['google', BOOTSTRAP_ACTOR],
    ]);
    const audits =
      await alpha.sql`select count(*)::int as n from tw_audit where action = 'installation.bootstrap'`;
    expect(audits.at(0)?.n).toBe(2);
    expect(sorted(await segmentCapabilities(alpha.deps))).toEqual(sorted(new Set(all)));
  });

  it('disable removes a provider capabilities at once; files.read stays env-only', async () => {
    const google = await getInstallation(alpha.deps, 'google');
    const next = await updateInstallation(alpha.deps, {
      id: 'google',
      expectedGeneration: google?.generation ?? 0,
      actor: 'admin@local.test',
      action: 'installation.disable',
      change: { desiredState: 'disabled' },
    });
    expect(next?.generation).toBe((google?.generation ?? 0) + 1);
    expect(sorted(await segmentCapabilities(alpha.deps))).toEqual(['files.read', 'github.read']);
    // A restart does not undo an admin's disable.
    await bootstrapInstallations(alpha.deps);
    expect(sorted(await segmentCapabilities(alpha.deps))).toEqual(['files.read', 'github.read']);
  });

  it('refuses a stale generation and narrows to the enabled subset', async () => {
    const stale = await updateInstallation(alpha.deps, {
      id: 'google',
      expectedGeneration: 1,
      actor: 'admin@local.test',
      action: 'installation.enable',
      change: { desiredState: 'enabled' },
    });
    expect(stale).toBeUndefined();
    const current = await getInstallation(alpha.deps, 'google');
    await updateInstallation(alpha.deps, {
      id: 'google',
      expectedGeneration: current?.generation ?? 0,
      actor: 'admin@local.test',
      action: 'installation.enable',
      change: { desiredState: 'enabled', capabilities: ['drive.read'] },
    });
    expect(sorted(await segmentCapabilities(alpha.deps))).toEqual([
      'drive.read',
      'files.read',
      'github.read',
    ]);
  });

  it('keeps two segment databases independent', async () => {
    await bootstrapInstallations(beta.deps);
    expect(sorted(await segmentCapabilities(beta.deps))).toEqual(sorted(new Set(all)));
    expect(sorted(await segmentCapabilities(alpha.deps))).not.toEqual(sorted(new Set(all)));
  });

  it('creates no row for an MCP server while Deps.mcp is unwired, even when the env allows notes.*', async () => {
    const gamma = await segment('gamma', [...all, 'notes.read', 'notes.write']);
    try {
      const itemIds = async () =>
        (
          await gamma.sql<
            { item_id: string }[]
          >`select item_id from tw_installations order by item_id`
        ).map((row) => row.item_id);
      await bootstrapInstallations(gamma.deps);
      expect(await itemIds()).toEqual(['github', 'google']);
      expect(await getInstallation(gamma.deps, 'notes')).toBeUndefined();

      await bootstrapInstallations({
        ...gamma.deps,
        mcp: () => Promise.reject(new Error('unused')),
      });
      expect(await itemIds()).toEqual(['github', 'google', 'notes']);
    } finally {
      await gamma.stop();
    }
  }, 120_000);
});
