import { randomUUID } from 'node:crypto';

import { IAP_ASSERTION_HEADER } from '@agent-works/domain';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { startDisposablePostgres } from '../../ledger/disposable-postgres.js';
import { applyWorkbenchMigration } from '../../workbench/migration.js';
import { createStarterTeam, seedCatalog } from '../catalog.js';
import { applyGraphMigration } from '../graph-migration.js';
import { alice, segmentDeps } from '../graph-test-support.js';
import { segmentCapabilities } from '../installations.js';
import { parseAgentRegistry } from '../mcp-task/index.js';
import { createRoutes } from '../routes.js';
import {
  applySkillPackagesMigration,
  createSkillPackageStore,
  syncCuratedPackages,
} from '../skill-packages/index.js';

import { designBot } from './design.js';
import { applyBotsMigration } from './migration.js';
import { createBotRoutes } from './routes.js';
import { createBotService } from './service.js';

import type { BotDesignCatalog } from './design.js';
import type { Caller } from '../../auth/iap.js';
import type { DisposablePostgres } from '../../ledger/disposable-postgres.js';
import type { Deps } from '../context.js';

let db: DisposablePostgres;
let sql: postgres.Sql;
let deps: Deps;
let teammateId: string;
let service: ReturnType<typeof createBotService>;
let catalog: BotDesignCatalog;

beforeAll(async () => {
  db = await startDisposablePostgres();
  sql = postgres(db.url, { onnotice: () => undefined });
  await applyWorkbenchMigration(sql);
  await applyGraphMigration(sql);
  await applyBotsMigration(sql);
  await applySkillPackagesMigration(sql);
  deps = segmentDeps(sql);
  await seedCatalog(deps);
  teammateId = (await createStarterTeam(deps, alice))[0].id;
  const skills = createSkillPackageStore(sql);
  await syncCuratedPackages({ store: skills });
  await skills.activate('brief-writer', '1.0.0', alice.sub);
  const agents = parseAgentRegistry(
    [
      {
        agentId: 'reference-research-agent',
        displayName: 'Reference researcher',
        protocol: 'mcp',
        contract: 'aw.task.v1',
        endpoint: 'http://127.0.0.1:8080/mcp',
        allowedHosts: ['127.0.0.1:8080'],
        supports: { cancel: true, lookupByIdempotencyKey: true, reportsCost: false },
        maxInputBytes: 10000,
        maxOutputBytes: 10000,
        callTimeoutMs: 10000,
        dataClassification: 'internal',
      },
    ],
    { allowLoopback: true },
  );
  service = createBotService(deps, async () => ({
    segmentCapabilities: await segmentCapabilities(deps),
    approvedAgents: agents,
    skills,
  }));
  const rows = await sql<
    { package_id: string; version: string; digest: string; name: string; description: string }[]
  >`select p.package_id, p.version, p.digest, s.name, s.description from tw_skill_packages p join tw_skill_package_skills s using (package_id, version) where p.state = 'activated'`;
  catalog = {
    agents: () =>
      agents.list().map(({ agentId, displayName, dataClassification }) => ({
        agentId,
        displayName,
        dataClassification,
      })),
    skills: () =>
      Promise.resolve(rows.map(({ package_id, ...row }) => ({ packageId: package_id, ...row }))),
  };
}, 60_000);
afterAll(async () => {
  await sql.end({ timeout: 1 });
  await db.stop();
});

describe('conversation design', () => {
  it('honors the feature flag, authentication, and CSRF at the route boundary', async () => {
    const request = {
      method: 'POST',
      path: `/v1/teamwork/bots/${teammateId}/design`,
      query: new URLSearchParams(),
      headers: { [IAP_ASSERTION_HEADER]: 'alice', 'x-csrf-token': 'test' },
      body: Buffer.from(
        JSON.stringify({ clientRequestId: randomUUID(), message: 'Hello', base: null }),
      ),
    };
    const verify = () =>
      Promise.resolve({ sub: alice.sub, email: alice.email, assertion: 'alice' } as Caller);
    const off = createRoutes(deps, verify, () => Promise.resolve({}), []);
    const on = createRoutes(
      deps,
      verify,
      () => Promise.resolve({}),
      createBotRoutes(deps, service, catalog),
    );
    expect((await off(request)).status).toBe(404);
    expect((await on({ ...request, headers: { [IAP_ASSERTION_HEADER]: 'alice' } })).status).toBe(
      403,
    );
  });
  it('rejects malformed and a2a proposals, stores validated revisions, and replays idempotently', async () => {
    const malformed = await designBot(deps, service, catalog, alice, teammateId, {
      clientRequestId: randomUUID(),
      message: '[malformed]',
      base: null,
    });
    expect(malformed.outcome).toBe('needs_changes');
    const a2a = await designBot(deps, service, catalog, alice, teammateId, {
      clientRequestId: randomUUID(),
      message: '[a2a]',
      base: null,
    });
    expect(a2a.outcome).toBe('needs_changes');
    if (a2a.outcome !== 'needs_changes') throw new Error('expected diagnostics');
    expect(a2a.diagnostics.some((item) => item.code === 'unsupported_protocol')).toBe(true);
    expect(await service.listRevisions(alice, teammateId)).toHaveLength(0);
    const input = { clientRequestId: randomUUID(), message: 'Create a brief', base: null };
    const [first, replay] = await Promise.all([
      designBot(deps, service, catalog, alice, teammateId, input),
      designBot(deps, service, catalog, alice, teammateId, input),
    ]);
    expect(first.outcome).toBe('draft');
    expect(replay).toEqual(first);
    expect(await sql`select id from wb_model_calls where purpose = 'bot_design'`).toHaveLength(3);
    if (first.outcome !== 'draft') throw new Error('expected draft');
    const revised = await designBot(deps, service, catalog, alice, teammateId, {
      clientRequestId: randomUUID(),
      message: 'Change the read step',
      base: { revision: first.revision, digest: first.digest },
    });
    expect(revised.outcome).toBe('draft');
    if (revised.outcome !== 'draft') throw new Error('expected revised draft');
    await expect(service.publish(alice, teammateId, first)).rejects.toMatchObject({
      code: 'stale_confirmation',
    });
    const router = createRoutes(
      deps,
      () => Promise.resolve({ sub: alice.sub, email: alice.email, assertion: 'alice' } as Caller),
      () => Promise.resolve({}),
      createBotRoutes(deps, service, catalog),
    );
    expect(
      await router({
        method: 'POST',
        path: `/v1/teamwork/bots/${teammateId}/publish`,
        query: new URLSearchParams(),
        headers: { [IAP_ASSERTION_HEADER]: 'alice', 'x-csrf-token': 'test' },
        body: Buffer.from(JSON.stringify({ revision: first.revision, digest: first.digest })),
      }),
    ).toMatchObject({ status: 409, body: { error: 'stale_confirmation' } });
    await service.publish(alice, teammateId, revised);
    expect(
      (await service.exportRevision(alice, teammateId, revised.revision)).provenance,
    ).toMatchObject({ source: 'conversation', sourceMessageId: revised.messageId });
    expect(
      await sql`select id from tw_messages where conversation_id = (select conversation_id from tw_teammates where id = ${teammateId}) and card->>'kind' = 'bot_draft'`,
    ).toHaveLength(4);
    const controlled = await designBot(deps, service, catalog, alice, teammateId, {
      clientRequestId: randomUUID(),
      message: '[event:m1-test:changed] [slow-agent]',
      base: { revision: revised.revision, digest: revised.digest },
    });
    expect(controlled.outcome).toBe('draft');
    if (controlled.outcome !== 'draft') throw new Error('expected controlled draft');
    const exported = await service.exportRevision(alice, teammateId, controlled.revision);
    expect(exported.definition.triggers).toContainEqual({
      kind: 'event',
      source: 'm1-test',
      eventType: 'changed',
    });
    expect(exported.definition.workflow.steps).toContainEqual(
      expect.objectContaining({
        kind: 'mcp_delegate',
        instruction: '[reference:slow-submit] Review the findings.',
      }),
    );
  }, 30_000);
  it('refuses read-only members before calling the model', async () => {
    const readonly = {
      ...deps,
      config: { ...deps.config, readOnlyMembers: new Set([alice.email]) },
    };
    await expect(
      designBot(readonly, service, catalog, alice, teammateId, {
        clientRequestId: randomUUID(),
        message: 'Edit',
        base: null,
      }),
    ).rejects.toMatchObject({ code: 'read_only_member', status: 403 });
  });
});
