import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';

import {
  canonicalPayloadSha256,
  IAP_ASSERTION_HEADER,
  parseBotProposal,
} from '@agent-works/domain';
import postgres from 'postgres';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { Unauthenticated } from '../../auth/iap.js';
import { startDisposablePostgres } from '../../ledger/disposable-postgres.js';
import { applyWorkbenchMigration } from '../../workbench/migration.js';
import { createStarterTeam, seedCatalog } from '../catalog.js';
import { applyGraphMigration } from '../graph-migration.js';
import { alice, segmentDeps } from '../graph-test-support.js';
import { createRoutes } from '../routes.js';

import { applyBotsMigration } from './migration.js';
import { previewBot } from './preview.js';
import { createBotRoutes } from './routes.js';
import { createBotService } from './service.js';

import type { Caller } from '../../auth/iap.js';
import type { DisposablePostgres } from '../../ledger/disposable-postgres.js';
import type { Deps, Member, Request } from '../context.js';
import type { BotDefinition, BotValidationContext, SkillResolution } from '@agent-works/domain';

let database: DisposablePostgres | undefined;
let sql: postgres.Sql;
let deps: Deps;
let teammateId: string;
let service: ReturnType<typeof createBotService>;
let context: BotValidationContext;
const pin = {
  packageId: 'curated/review',
  version: '1.0.0',
  digest: 'a'.repeat(64),
  name: 'review',
};
const definition = (): BotDefinition => ({
  apiVersion: 'agent-works.bot/v1',
  name: 'Daily review',
  purpose: 'Summarize changes',
  planning: { mode: 'fixed' },
  workflow: {
    steps: [
      {
        id: 'read',
        title: 'Read documents',
        kind: 'connector_read',
        dependsOn: [],
        capability: 'drive.read',
        query: 'Find changes',
      },
      { id: 'result', title: 'Send summary', kind: 'result', dependsOn: ['read'], from: 'read' },
    ],
  },
  triggers: [{ kind: 'manual' }],
  approvals: { mode: 'per_run' },
  limits: {
    maxConcurrentRunsPerBot: 1,
    maxConcurrentRunsPerUser: 1,
    runTimeoutMinutes: 60,
    maxCostMicros: null,
  },
  result: { destination: 'inbox' },
});
const draft = () => service.createDraft(alice, teammateId, definition(), { source: 'api' });
const bob: Member = { sub: 'local-test:bob', email: 'bob@local.test' };

beforeAll(async () => {
  database = await startDisposablePostgres();
  sql = postgres(database.url, { onnotice: () => undefined });
  await applyWorkbenchMigration(sql);
  await applyGraphMigration(sql);
  await applyBotsMigration(sql);
}, 60_000);
afterAll(async () => {
  await sql.end({ timeout: 1 });
  await database?.stop();
});
beforeEach(async () => {
  await sql`truncate wb_tasks, wb_model_calls, tw_teammates, tw_conversations, tw_messages, tw_audit, tw_jobs cascade`;
  deps = segmentDeps(sql);
  await seedCatalog(deps);
  teammateId = (await createStarterTeam(deps, alice))[0].id;
  context = {
    segmentCapabilities: new Set(['drive.read']),
    approvedAgents: {
      get: (agentId) =>
        agentId === 'reviewer'
          ? {
              agentId,
              displayName: 'External reviewer',
              protocol: 'mcp',
              dataClassification: 'INTERNAL',
              supports: { cancel: true, lookupByIdempotencyKey: true, reportsCost: false },
            }
          : undefined,
    },
    skills: {
      resolve: (ref) =>
        Promise.resolve({
          ok: true,
          skill: {
            ...ref,
            description: 'Review',
            instructions: 'Summarize',
            allowedTools: ['drive.read'],
            provenance: { source: 'curated', path: 'review', loadedAt: '2026-11-04T00:00:00.000Z' },
          },
        }),
    },
  };
  service = createBotService(deps, () => Promise.resolve(context));
});

describe('bot revisions in real Postgres', () => {
  it('applies the migration twice and preserves existing teamwork rows', async () => {
    await applyBotsMigration(sql);
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- fixed repository migration URL
    const body = readFileSync(
      new URL('../../../migrations/0031_bots.sql', import.meta.url),
      'utf8',
    );
    await sql.begin(async (tx) => {
      await tx`select pg_advisory_xact_lock(7017)`;
      await tx.unsafe(body);
    });
    expect(await sql`select * from schema_migrations where name = '0031_bots.sql'`).toHaveLength(1);
    expect(await service.getActive(alice, teammateId)).toBeUndefined();
    expect(await sql`select * from tw_teammates where id = ${teammateId}`).toHaveLength(1);
  });
  it('upgrades existing flagship and teamwork tasks without invalidating their rows', async () => {
    await sql`create schema legacy_bots_upgrade`;
    if (database === undefined) throw new Error('test database missing');
    const legacy = postgres(database.url, {
      onnotice: () => undefined,
      connection: { search_path: 'legacy_bots_upgrade' },
    });
    try {
      await applyWorkbenchMigration(legacy);
      await applyGraphMigration(legacy);
      const flagshipId = randomUUID();
      const teamworkId = randomUUID();
      await legacy`insert into wb_tasks (id, owner_sub, client_request_id, title, objective, status, version, llm_mode, model_id, created_at, updated_at) values (${flagshipId}, ${alice.sub}, ${randomUUID()}, 'Existing flagship', 'Keep it', 'executing', 1, 'stub', 'stub', now(), now())`;
      await legacy`insert into wb_tasks (id, owner_sub, client_request_id, title, objective, status, version, llm_mode, model_id, kind, segment, workflow, mode, result_owner, scope, created_at, updated_at) values (${teamworkId}, ${alice.sub}, ${randomUUID()}, 'Existing teamwork', 'Keep it', 'plan_review', 1, 'stub', 'stub', 'teamwork', 'alpha', 'research_brief', 'manual', ${randomUUID()}, '{}'::jsonb, now(), now())`;
      const before = await legacy`select id, kind, status, version from wb_tasks order by id`;
      await applyBotsMigration(legacy);
      await applyBotsMigration(legacy);
      expect(await legacy`select id, kind, status, version from wb_tasks order by id`).toEqual(
        before,
      );
      expect(await legacy`select * from tw_bots`).toHaveLength(0);
    } finally {
      await legacy.end({ timeout: 1 });
    }
  });
  it('creates and previews a canonical draft, then publishes only its digest', async () => {
    const created = await draft();
    const preview = await service.previewDraft(alice, teammateId);
    expect(preview).toMatchObject({
      revision: 1,
      digest: canonicalPayloadSha256(definition()),
      capabilities: ['drive.read'],
      result: { destination: 'inbox' },
    });
    expect(preview.steps.map((step) => step.id)).toEqual(['read', 'result']);
    const published = await service.publish(alice, teammateId, created);
    expect(published.state).toBe('published');
    expect(await service.getActive(alice, teammateId)).toEqual(published);
    expect(await sql`select action from tw_audit where action = 'bot.publish'`).toHaveLength(1);
  });
  it('returns specific diagnostics and persists nothing for malformed proposals', async () => {
    await expect(
      service.createDraft(
        alice,
        teammateId,
        { ...definition(), planning: { mode: 'dynamic' } },
        { source: 'conversation', sourceMessageId: randomUUID() },
      ),
    ).rejects.toMatchObject({
      diagnostics: [expect.objectContaining({ code: 'unsupported_planning_mode' })],
    });
    expect(await sql`select * from tw_bot_revisions`).toHaveLength(0);
    expect(await sql`select * from tw_bots`).toHaveLength(0);
  });
  it.each([
    'cycle',
    'dangling_reference',
    'result_count',
    'unreachable_step',
    'unsupported_protocol',
    'unknown_agent',
    'digest_mismatch',
    'write_capability',
  ])('persists no revision for %s', async (code) => {
    const def = definition();
    const [read, result] = def.workflow.steps;
    const delegate = {
      id: 'delegate',
      title: 'Review',
      dependsOn: ['read'],
      kind: 'mcp_delegate',
      agent: { agentId: 'reviewer', protocol: 'mcp' },
      instruction: 'Review',
      inputs: ['read'],
      timeoutSeconds: 60,
    };
    const proposals: ReadonlyMap<string, unknown[]> = new Map([
      ['cycle', [{ ...read, dependsOn: ['result'] }, result]],
      ['dangling_reference', [read, { ...result, dependsOn: ['missing'], from: 'missing' }]],
      ['result_count', [read, result, { ...result, id: 'result_two' }]],
      ['unreachable_step', [read, { ...read, id: 'orphan' }, result]],
      [
        'unsupported_protocol',
        [
          read,
          { ...delegate, agent: { agentId: 'reviewer', protocol: 'a2a' } },
          { ...result, dependsOn: ['delegate'], from: 'delegate' },
        ],
      ],
      [
        'unknown_agent',
        [
          read,
          { ...delegate, agent: { agentId: 'unknown', protocol: 'mcp' } },
          { ...result, dependsOn: ['delegate'], from: 'delegate' },
        ],
      ],
      [
        'digest_mismatch',
        [
          read,
          {
            id: 'skill',
            title: 'Summarize',
            dependsOn: ['read'],
            kind: 'skill',
            skill: pin,
            inputs: ['read'],
          },
          { ...result, dependsOn: ['skill'], from: 'skill' },
        ],
      ],
      ['write_capability', [{ ...read, capability: 'docs.publish' }, result]],
    ]);
    if (code === 'digest_mismatch')
      context = {
        ...context,
        skills: { resolve: () => Promise.resolve({ ok: false, code: 'digest_mismatch' }) },
      };
    await expect(
      service.createDraft(
        alice,
        teammateId,
        { ...def, workflow: { steps: proposals.get(code) } },
        { source: 'conversation' },
      ),
    ).rejects.toHaveProperty(
      'diagnostics',
      expect.arrayContaining([expect.objectContaining({ code })]),
    );
    expect(await sql`select * from tw_bot_revisions`).toHaveLength(0);
    expect(await sql`select * from tw_bots`).toHaveLength(0);
  });
  it('rejects stale revision and stale digest without publishing', async () => {
    const created = await draft();
    await expect(
      service.publish(alice, teammateId, { ...created, revision: 2 }),
    ).rejects.toMatchObject({ code: 'stale_confirmation', status: 409 });
    await expect(
      service.publish(alice, teammateId, { ...created, digest: 'b'.repeat(64) }),
    ).rejects.toMatchObject({ code: 'stale_confirmation', status: 409 });
    expect(await service.getActive(alice, teammateId)).toBeUndefined();
  });
  it('discards an old draft on revise and rejects its confirmation', async () => {
    const old = await draft();
    const next = await service.reviseDraft(
      alice,
      teammateId,
      { baseRevision: old.revision, baseDigest: old.digest },
      { ...definition(), purpose: 'A new purpose' },
    );
    await expect(service.publish(alice, teammateId, old)).rejects.toMatchObject({
      code: 'stale_confirmation',
    });
    await expect(
      service.reviseDraft(
        alice,
        teammateId,
        { baseRevision: old.revision, baseDigest: old.digest },
        definition(),
      ),
    ).rejects.toMatchObject({ code: 'stale_confirmation' });
    expect((await service.listRevisions(alice, teammateId)).map((row) => row.state)).toEqual([
      'draft',
      'discarded',
    ]);
    expect(next.revision).toBe(2);
  });
  it('allows exactly one of two concurrent publishes', async () => {
    const created = await draft();
    const outcomes = await Promise.allSettled([
      service.publish(alice, teammateId, created),
      service.publish(alice, teammateId, created),
    ]);
    expect(outcomes.filter((outcome) => outcome.status === 'fulfilled')).toHaveLength(1);
    expect(outcomes.filter((outcome) => outcome.status === 'rejected')).toMatchObject([
      { reason: { code: 'stale_confirmation', status: 409 } },
    ]);
  });
  it('serializes a concurrent revise against publication', async () => {
    const old = await draft();
    let unlock: () => void = () => undefined;
    let entered: () => void = () => undefined;
    const held = new Promise<void>((resolve) => {
      unlock = resolve;
    });
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const lock = sql.begin(async (tx) => {
      await tx`select id from tw_teammates where id = ${teammateId} for update`;
      entered();
      await held;
    });
    await started;
    const revise = service.reviseDraft(
      alice,
      teammateId,
      { baseRevision: old.revision, baseDigest: old.digest },
      { ...definition(), name: 'Edited' },
    );
    const publish = service.publish(alice, teammateId, old);
    unlock();
    await lock;
    const outcomes = await Promise.allSettled([revise, publish]);
    expect(outcomes[0].status).toBe('fulfilled');
    if (outcomes[1].status === 'fulfilled') expect(outcomes[1].value.digest).toBe(old.digest);
    else expect(outcomes[1].reason).toMatchObject({ code: 'stale_confirmation' });
    await expect(service.publish(alice, teammateId, old)).rejects.toMatchObject({
      code: 'stale_confirmation',
    });
  });
  it('rejects published content, metadata, deletion, and state changes in the database', async () => {
    const created = await draft();
    await service.publish(alice, teammateId, created);
    await expect(
      sql`update tw_bot_revisions set definition = '{}'::jsonb where teammate_id = ${teammateId}`,
    ).rejects.toThrow('immutable');
    await expect(
      sql`update tw_bot_revisions set published_by = 'someone' where teammate_id = ${teammateId}`,
    ).rejects.toThrow('immutable');
    await expect(
      sql`delete from tw_bot_revisions where teammate_id = ${teammateId}`,
    ).rejects.toThrow('never deleted');
    await expect(
      sql`update tw_bot_revisions set state = 'draft' where teammate_id = ${teammateId}`,
    ).rejects.toThrow('immutable');
  });
  it('keeps run pins unchanged across edits and supersession and deduplicates triggers', async () => {
    const old = await draft();
    await service.publish(alice, teammateId, old);
    const pinned = await service.pinForRun(teammateId);
    const taskId = randomUUID();
    await sql`insert into wb_tasks (id, owner_sub, client_request_id, title, objective, status, version, llm_mode, model_id, kind, segment, created_at, updated_at) values (${taskId}, ${alice.sub}, ${randomUUID()}, 'Bot run', 'Review', 'queued', 1, 'stub', 'stub', 'bot', 'alpha', now(), now())`;
    await sql`insert into tw_bot_runs (task_id, teammate_id, revision, digest, trigger_kind, trigger_ref, owner_sub, initiated_by, execution_sub, approval_mode, created_at, updated_at) values (${taskId}, ${teammateId}, ${pinned.revision}, ${pinned.digest}, 'event', 'event:one', ${alice.sub}, 'event:source:one', ${alice.sub}, 'per_run', now(), now())`;
    await sql`insert into tw_bot_steps (task_id, step_id, kind, status, created_at, updated_at) values (${taskId}, 'read', 'connector_read', 'pending', now(), now())`;
    const next = await service.reviseDraft(
      alice,
      teammateId,
      { baseRevision: old.revision, baseDigest: old.digest },
      { ...definition(), name: 'Changed' },
    );
    expect((await service.pinForRun(teammateId)).revision).toBe(1);
    await service.publish(alice, teammateId, next);
    expect((await service.pinForRun(teammateId)).revision).toBe(2);
    expect(
      (await sql`select revision, digest, cost from tw_bot_runs where task_id = ${taskId}`)[0],
    ).toMatchObject({ revision: 1, digest: old.digest, cost: { completeness: 'unknown' } });
    await expect(
      sql`update tw_bot_runs set revision = 2, digest = ${next.digest} where task_id = ${taskId}`,
    ).rejects.toThrow('immutable');
    const duplicateId = randomUUID();
    await sql`insert into wb_tasks (id, owner_sub, client_request_id, title, objective, status, version, llm_mode, model_id, kind, segment, created_at, updated_at) values (${duplicateId}, ${alice.sub}, ${randomUUID()}, 'Duplicate', 'Review', 'queued', 1, 'stub', 'stub', 'bot', 'alpha', now(), now())`;
    await expect(
      sql`insert into tw_bot_runs select ${duplicateId}, teammate_id, revision, digest, trigger_kind, trigger_ref, owner_sub, initiated_by, execution_sub, approval_mode, grant_id, cost, created_at, updated_at, started_at, finished_at from tw_bot_runs where task_id = ${taskId}`,
    ).rejects.toMatchObject({
      code: '23505',
      constraint_name: 'tw_bot_runs_teammate_id_trigger_ref_key',
    });
    expect((await service.listRevisions(alice, teammateId)).map((r) => r.state)).toEqual([
      'published',
      'superseded',
    ]);
  });
  it('round trips readable export with provenance and the same digest', async () => {
    const created = await service.createDraft(alice, teammateId, definition(), {
      source: 'import',
    });
    await service.publish(alice, teammateId, created);
    const exported = await service.exportRevision(alice, teammateId, created.revision);
    const parsed = parseBotProposal(JSON.parse(JSON.stringify(exported.definition)));
    expect(parsed.success).toBe(true);
    if (parsed.success) expect(canonicalPayloadSha256(parsed.definition)).toBe(exported.digest);
    expect(exported.provenance).toMatchObject({
      source: 'import',
      revision: 1,
      publishedBy: alice.sub,
    });
  });
  it('hides all bot operations from non-owners', async () => {
    const created = await draft();
    const attempts = [
      service.createDraft(bob, teammateId, definition(), { source: 'api' }),
      service.getActive(bob, teammateId),
      service.previewDraft(bob, teammateId),
      service.listRevisions(bob, teammateId),
      service.exportRevision(bob, teammateId, 1),
      service.publish(bob, teammateId, created),
      service.reviseDraft(
        bob,
        teammateId,
        { baseRevision: 1, baseDigest: created.digest },
        definition(),
      ),
    ];
    const outcomes = await Promise.allSettled(attempts);
    for (const outcome of outcomes)
      expect(outcome).toMatchObject({
        status: 'rejected',
        reason: { code: 'not_found', status: 404 },
      });
  });
  it('revalidates the current catalog and policy before publish', async () => {
    const created = await draft();
    context = { ...context, segmentCapabilities: new Set() };
    await expect(service.publish(alice, teammateId, created)).rejects.toMatchObject({
      diagnostics: [expect.objectContaining({ code: 'capability_not_allowed' })],
    });
    expect(await service.getActive(alice, teammateId)).toBeUndefined();
  });
});

describe('preview and authenticated bot routes', () => {
  function router(enabled = true) {
    return createRoutes(
      deps,
      (assertion) => {
        if (assertion !== 'alice') throw new Unauthenticated('missing');
        return Promise.resolve({ sub: alice.sub, email: alice.email, assertion } as Caller);
      },
      () => Promise.resolve({}),
      enabled ? createBotRoutes(deps, service) : [],
    );
  }
  function request(method: string, suffix: string, payload?: unknown): Request {
    return {
      method,
      path: `/v1/teamwork/bots/${teammateId}${suffix}`,
      query: new URLSearchParams(),
      headers: { [IAP_ASSERTION_HEADER]: 'alice', 'x-csrf-token': 'test' },
      body: Buffer.from(payload === undefined ? '' : JSON.stringify(payload)),
    };
  }
  it('uses the shared auth and CSRF boundary and returns 404 when routes are off', async () => {
    expect((await router(false)(request('GET', '/revisions'))).status).toBe(404);
    expect(
      (
        await router()({
          ...request('POST', '/drafts'),
          headers: { [IAP_ASSERTION_HEADER]: 'alice' },
        })
      ).status,
    ).toBe(403);
    expect((await router()({ ...request('GET', '/revisions'), headers: {} })).status).toBe(401);
    expect((await router()({ ...request('POST', '/drafts'), body: Buffer.from('{') })).status).toBe(
      400,
    );
  });
  it('exposes draft, preview, publication, revision history, active revision and export', async () => {
    const handle = router();
    expect(
      (await handle(request('POST', '/drafts', { definition: definition(), source: 'api' })))
        .status,
    ).toBe(201);
    const preview = await service.previewDraft(alice, teammateId);
    expect((await handle(request('GET', '/preview'))).body).toMatchObject({
      apiVersion: 'teamwork.v1',
      preview: { revision: 1, digest: preview.digest },
    });
    expect(
      (await handle(request('POST', '/publish', { revision: 1, digest: 'b'.repeat(64) }))).status,
    ).toBe(409);
    expect(
      (await handle(request('POST', '/publish', { revision: 1, digest: preview.digest }))).status,
    ).toBe(200);
    expect((await handle(request('GET', '/active'))).status).toBe(200);
    expect((await handle(request('GET', '/revisions'))).body).toMatchObject({
      revisions: [{ state: 'published' }],
    });
    expect((await handle(request('GET', '/revisions/1/export'))).body).toMatchObject({
      export: { digest: preview.digest },
    });
  });
  it('returns proposal diagnostics in JSON', async () => {
    const reply = await router()(request('POST', '/drafts', { definition: {}, source: 'api' }));
    expect(reply.status).toBe(400);
    expect(reply.body).toMatchObject({
      error: 'invalid_bot_definition',
    });
    expect(reply.body).toHaveProperty(
      'diagnostics',
      expect.arrayContaining([expect.objectContaining({ code: 'invalid_schema' })]),
    );
    expect(await sql`select * from tw_bot_revisions`).toHaveLength(0);
  });
  it('previews all external data, package pins, trigger policies, and checkpoints', async () => {
    const def = definition();
    def.workflow.steps.splice(
      1,
      0,
      {
        id: 'skill',
        title: 'Summarize',
        dependsOn: ['read'],
        kind: 'skill',
        skill: pin,
        inputs: ['read'],
      },
      {
        id: 'review',
        title: 'Ask external reviewer',
        dependsOn: ['skill'],
        kind: 'mcp_delegate',
        agent: { agentId: 'reviewer', protocol: 'mcp' },
        instruction: 'Review summary',
        inputs: ['read', 'skill'],
        timeoutSeconds: 60,
      },
      {
        id: 'checkpoint',
        title: 'Approve review',
        dependsOn: ['review'],
        kind: 'approval',
        prompt: 'Approve the review?',
      },
    );
    def.workflow.steps[4] = {
      id: 'result',
      title: 'Send summary',
      kind: 'result',
      dependsOn: ['checkpoint'],
      from: 'review',
    };
    def.triggers = [
      {
        kind: 'schedule',
        timezone: 'Asia/Tokyo',
        timing: { kind: 'cron', expression: '0 9 * * *' },
        missedRun: 'run_once',
      },
      { kind: 'event', source: 'signed-source', eventType: 'updated' },
    ];
    const preview = await previewBot(def, context);
    expect(preview.success).toBe(true);
    if (!preview.success) return;
    expect(preview.preview.skills).toEqual([{ stepId: 'skill', ...pin }]);
    expect(
      preview.preview.externalAgents[0].dataSentExternally.map((entry) => entry.stepId),
    ).toEqual(['read', 'skill']);
    expect(preview.preview.triggers[0].description).toContain('Asia/Tokyo');
    expect(preview.preview.triggers[0].description).toContain('Run once');
    expect(preview.preview.approvals.checkpoints).toEqual([
      { stepId: 'checkpoint', prompt: 'Approve the review?' },
    ]);
    const refused: SkillResolution = { ok: false, code: 'digest_mismatch' };
    expect(
      await previewBot(def, { ...context, skills: { resolve: () => Promise.resolve(refused) } }),
    ).toMatchObject({ success: false });
  });
});
