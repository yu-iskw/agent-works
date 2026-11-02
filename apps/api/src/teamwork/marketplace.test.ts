import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { IAP_ASSERTION_HEADER } from '@agent-works/domain';
import postgres from 'postgres';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { startDisposablePostgres } from '../ledger/disposable-postgres.js';
import { applyWorkbenchMigration } from '../workbench/migration.js';

import { listTemplates, seedCatalog } from './catalog.js';
import { readSegmentConfig } from './config.js';
import { bootstrapInstallations, getInstallation, segmentCapabilities } from './installations.js';
import { createRoutes } from './routes.js';

import type { Deps, Reply } from './context.js';
import type { Capability } from '@agent-works/domain/teamwork';

type Database = Awaited<ReturnType<typeof startDisposablePostgres>>;

// bigquery.query is in the google manifest but not in this segment's env allowlist.
const ENV_CAPABILITIES: readonly Capability[] = [
  'drive.read',
  'docs.publish',
  'github.read',
  'files.read',
];

let database: Database;
let sql: postgres.Sql;
let deps: Deps;
let call: (
  email: string,
  method: 'GET' | 'POST',
  path: string,
  payload?: unknown,
) => Promise<Reply>;

beforeAll(async () => {
  database = await startDisposablePostgres();
  sql = postgres(database.url, { onnotice: () => undefined });
  await applyWorkbenchMigration(sql);
  const base = readSegmentConfig({
    AW_SEGMENT_ID: 'alpha',
    AW_IDENTITY: 'local-test',
    AW_SOURCE_MODE: 'fixture',
    AW_LOCAL_TEST_MEMBERS: 'alice@local.test,bob@local.test',
    AW_LOCAL_TEST_ADMINS: 'alice@local.test',
    AW_KEY_DIR: mkdtempSync(join(tmpdir(), 'tw-keys-')),
  });
  deps = {
    sql,
    config: { ...base, capabilities: new Set(ENV_CAPABILITIES) },
    now: () => new Date(),
    newId: () => crypto.randomUUID(),
  } as unknown as Deps;
  const handle = createRoutes(
    deps,
    (assertion) =>
      Promise.resolve({ sub: `local-test:${assertion}`, email: assertion, assertion } as never),
    () => Promise.resolve({}),
  );
  call = (email, method, path, payload) => {
    const url = new URL(path, 'http://segment.test');
    return handle({
      method,
      path: url.pathname,
      query: url.searchParams,
      headers: { [IAP_ASSERTION_HEADER]: email, 'x-csrf-token': 'test' },
      body: Buffer.from(payload === undefined ? '' : JSON.stringify(payload)),
    });
  };
  await seedCatalog(deps);
}, 60_000);

afterAll(async () => {
  await sql.end({ timeout: 1 });
  await database.stop();
});

beforeEach(async () => {
  await sql`truncate tw_installations, tw_audit`;
  await bootstrapInstallations(deps);
});

const ADMIN = 'alice@local.test';
const MEMBER = 'bob@local.test';
const API = '/v1/teamwork/marketplace';

type Listing = { kind: string; id: string; status: string; version: string; href?: string };
const listings = (reply: Reply) => (reply.body as { listings: Listing[] }).listings;
const installation = (reply: Reply) =>
  (reply.body as { installation: { generation: number; capabilities: string[] } }).installation;
const errorOf = (reply: Reply) => (reply.body as { error: string }).error;
const generationOf = async (id: string) => (await getInstallation(deps, id))?.generation ?? 0;

const sorted = (set: ReadonlySet<Capability>) => [...set].sort((a, b) => a.localeCompare(b));

describe('marketplace browse', () => {
  it('lists every kind and filters by kind', async () => {
    const all = listings(await call(MEMBER, 'GET', API));
    expect(new Set(all.map((listing) => listing.kind))).toEqual(
      new Set(['connector', 'team_bot', 'mcp_server', 'a2a_agent']),
    );
    const connectors = listings(await call(MEMBER, 'GET', `${API}?kind=connector`));
    expect(connectors.map((listing) => [listing.id, listing.status])).toEqual([
      ['google', 'enabled'],
      ['github', 'enabled'],
    ]);
    expect(listings(await call(MEMBER, 'GET', `${API}?kind=team_bot`)).length).toBeGreaterThan(0);
  });

  it('rejects an unknown kind and an unknown query key', async () => {
    expect((await call(MEMBER, 'GET', `${API}?kind=plugin`)).status).toBe(400);
    expect((await call(MEMBER, 'GET', `${API}?segment=beta`)).status).toBe(400);
  });

  it('projects team bots from listTemplates without copying them', async () => {
    const before = await sql`select count(*)::int as n from tw_templates`;
    const rows = listings(await call(MEMBER, 'GET', `${API}?kind=team_bot`));
    const templates = await listTemplates(deps, { sub: `local-test:${MEMBER}`, email: MEMBER });
    expect(rows.map((row) => row.id).sort((a, b) => a.localeCompare(b))).toEqual(
      templates.map((template) => template.id).sort((a, b) => a.localeCompare(b)),
    );
    expect(rows.every((row) => row.status === 'available' && row.href === '/catalog')).toBe(true);
    expect(await sql`select count(*)::int as n from tw_templates`).toEqual(before);
  });

  it('lists MCP servers and A2A agents as coming soon', async () => {
    for (const kind of ['mcp_server', 'a2a_agent']) {
      const rows = listings(await call(MEMBER, 'GET', `${API}?kind=${kind}`));
      expect(rows.map((row) => row.status)).toEqual(['coming_soon']);
      const detail = await call(MEMBER, 'GET', `${API}/${kind}/${rows[0]?.id}`);
      expect(detail.status).toBe(200);
      expect((await call(MEMBER, 'POST', `${API}/connectors/${rows[0]?.id}`, {})).status).toBe(403);
    }
  });

  it('shows connector detail with read and write kept apart', async () => {
    const reply = await call(MEMBER, 'GET', `${API}/connector/google`);
    const item = (
      reply.body as {
        item: {
          capabilities: { id: string; access: string; allowedByEnv: boolean; enabled: boolean }[];
          installation: { generation: number };
        };
      }
    ).item;
    expect(item.capabilities.map((c) => [c.id, c.access, c.allowedByEnv, c.enabled])).toEqual([
      ['drive.read', 'read', true, true],
      ['bigquery.query', 'read', false, false],
      ['docs.publish', 'write', true, true],
    ]);
    expect(item.installation.generation).toBe(1);
  });

  it('shows team bot detail and 404s on unknown items', async () => {
    const [first] = listings(await call(MEMBER, 'GET', `${API}?kind=team_bot`));
    expect((await call(MEMBER, 'GET', `${API}/team_bot/${first.id}`)).status).toBe(200);
    expect((await call(MEMBER, 'GET', `${API}/connector/nope`)).status).toBe(404);
    expect(
      (await call(MEMBER, 'GET', `${API}/team_bot/00000000-0000-4000-8000-000000000000`)).status,
    ).toBe(404);
  });

  it('lists installations', async () => {
    const reply = await call(MEMBER, 'GET', `${API}/installations`);
    const rows = (reply.body as { installations: { connector: string; desiredState: string }[] })
      .installations;
    expect(rows.map((row) => [row.connector, row.desiredState])).toEqual([
      ['github', 'enabled'],
      ['google', 'enabled'],
    ]);
  });
});

describe('marketplace admin mutation', () => {
  it('forbids a non-admin member and changes nothing', async () => {
    const generation = await generationOf('google');
    const reply = await call(MEMBER, 'POST', `${API}/connectors/google`, {
      action: 'disable',
      expectedGeneration: generation,
    });
    expect(reply.status).toBe(403);
    expect(await generationOf('google')).toBe(generation);
  });

  it('disables and re-enables without a restart, auditing each change', async () => {
    const off = await call(ADMIN, 'POST', `${API}/connectors/google`, {
      action: 'disable',
      expectedGeneration: 1,
    });
    expect(off.status).toBe(200);
    expect(sorted(await segmentCapabilities(deps))).toEqual(['files.read', 'github.read']);
    const on = await call(ADMIN, 'POST', `${API}/connectors/google`, {
      action: 'enable',
      expectedGeneration: installation(off).generation,
    });
    expect(on.status).toBe(200);
    expect(sorted(await segmentCapabilities(deps))).toEqual(sorted(new Set(ENV_CAPABILITIES)));
    const audits = await sql<{ action: string; detail: Record<string, unknown> }[]>`
      select action, detail from tw_audit where action like 'installation.%' and action <> 'installation.bootstrap'
      order by at, id
    `;
    expect(audits.map((row) => row.action)).toEqual([
      'installation.disable',
      'installation.enable',
    ]);
    for (const row of audits)
      expect(Object.keys(row.detail).sort((a, b) => a.localeCompare(b))).toEqual([
        'actor',
        'connector',
        'generation',
      ]);
  });

  it('answers a stale expectedGeneration with 409 and leaves the row alone', async () => {
    await call(ADMIN, 'POST', `${API}/connectors/google`, {
      action: 'disable',
      expectedGeneration: 1,
    });
    const stale = await call(ADMIN, 'POST', `${API}/connectors/google`, {
      action: 'enable',
      expectedGeneration: 1,
    });
    expect(stale.status).toBe(409);
    expect(errorOf(stale)).toBe('stale_generation');
    expect((await getInstallation(deps, 'google'))?.desired_state).toBe('disabled');
  });

  it('settles concurrent writes on one generation to one winner', async () => {
    const [a, b] = await Promise.all([
      call(ADMIN, 'POST', `${API}/connectors/google`, { action: 'disable', expectedGeneration: 1 }),
      call(ADMIN, 'POST', `${API}/connectors/google`, {
        action: 'set_capabilities',
        capabilities: ['drive.read'],
        expectedGeneration: 1,
      }),
    ]);
    expect([a.status, b.status].sort((x, y) => x - y)).toEqual([200, 409]);
    const row = await getInstallation(deps, 'google');
    expect(row?.generation).toBe(2);
    expect(row?.desired_state).toBe(a.status === 200 ? 'disabled' : 'enabled');
  });

  it('rejects capabilities outside the manifest or the env allowlist', async () => {
    const generation = await generationOf('google');
    const outsideEnv = await call(ADMIN, 'POST', `${API}/connectors/google`, {
      action: 'set_capabilities',
      capabilities: ['bigquery.query'],
      expectedGeneration: generation,
    });
    expect(outsideEnv.status).toBe(400);
    expect(errorOf(outsideEnv)).toBe('capability_not_allowed');
    const outsideManifest = await call(ADMIN, 'POST', `${API}/connectors/google`, {
      action: 'enable',
      capabilities: ['github.read'],
      expectedGeneration: generation,
    });
    expect(outsideManifest.status).toBe(400);
    expect(await generationOf('google')).toBe(generation);
    const refused = await sql`select 1 from tw_audit where outcome = 'capability_not_allowed'`;
    expect(refused.length).toBe(2);
  });

  it('keeps read and write independent', async () => {
    const narrowed = await call(ADMIN, 'POST', `${API}/connectors/google`, {
      action: 'set_capabilities',
      capabilities: ['drive.read'],
      expectedGeneration: 1,
    });
    expect(installation(narrowed).capabilities).toEqual(['drive.read']);
    expect(sorted(await segmentCapabilities(deps))).not.toContain('docs.publish');
    const off = await call(ADMIN, 'POST', `${API}/connectors/google`, {
      action: 'disable',
      expectedGeneration: installation(narrowed).generation,
    });
    // Re-enabling without a list restores the stored subset; it never widens it.
    const on = await call(ADMIN, 'POST', `${API}/connectors/google`, {
      action: 'enable',
      expectedGeneration: installation(off).generation,
    });
    expect(installation(on).capabilities).toEqual(['drive.read']);
    expect(sorted(await segmentCapabilities(deps))).not.toContain('docs.publish');
  });

  it.each([
    { segment: 'beta' },
    { actor: 'bob@local.test' },
    { updatedBy: 'bob@local.test' },
    { ownerSub: 'local-test:bob@local.test' },
  ])('refuses a body that carries %j', async (extra) => {
    const reply = await call(ADMIN, 'POST', `${API}/connectors/google`, {
      action: 'disable',
      expectedGeneration: 1,
      ...extra,
    });
    expect(reply.status).toBe(400);
    expect(await generationOf('google')).toBe(1);
  });

  it('refuses an unknown action and an unknown connector', async () => {
    expect(
      (
        await call(ADMIN, 'POST', `${API}/connectors/google`, {
          action: 'upgrade',
          expectedGeneration: 1,
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await call(ADMIN, 'POST', `${API}/connectors/nope`, {
          action: 'disable',
          expectedGeneration: 1,
        })
      ).status,
    ).toBe(404);
  });
});
