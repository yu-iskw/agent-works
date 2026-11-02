import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createSealer } from '@agent-works/domain/sealer';
import postgres from 'postgres';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { startDisposablePostgres } from '../ledger/disposable-postgres.js';
import { applyWorkbenchMigration } from '../workbench/migration.js';

import { createStarterTeam, seedCatalog } from './catalog.js';
import { readSegmentConfig } from './config.js';
import { invoke, publishThroughGateway, readThroughGateway } from './gateway.js';
import { bootstrapInstallations, updateInstallation } from './installations.js';
import { createModelGate } from './model.js';
import { createScriptedModel } from './scripted-model.js';
import { createFixtureSources } from './sources/fixture.js';
import { createTask, publishDigest } from './tasks.js';

import type { Deps, Member } from './context.js';
import type { SourcePort, TokenSource } from './sources/port.js';
import type { Capability, PublishProposal } from '@agent-works/domain/teamwork';

const alice: Member = { sub: 'local-test:alice', email: 'alice@local.test' };
const bob: Member = { sub: 'local-test:bob', email: 'bob@local.test' };
const root = new URL('../../../../', import.meta.url).pathname;
const sealer = createSealer(Buffer.alloc(32, 1), 'test');

const all: readonly Capability[] = [
  'drive.read',
  'docs.publish',
  'bigquery.query',
  'github.read',
  'files.read',
];

let database: Awaited<ReturnType<typeof startDisposablePostgres>> | undefined;
let sql: postgres.Sql;

/** What reached the provider side; a denied call must leave every counter untouched. */
const stats = {
  reads: 0,
  publishes: 0,
  tokens: 0,
  hold: undefined as Promise<void> | undefined,
  entered: undefined as (() => void) | undefined,
};

const token: TokenSource = () => {
  stats.tokens += 1;
  return Promise.resolve('x');
};

function countingSources(): SourcePort {
  const fixture = createFixtureSources({ root, segment: 'alpha', sql, faults: false });
  return {
    mode: fixture.mode,
    findPublished: (...args) => fixture.findPublished(...args),
    async read(request) {
      stats.reads += 1;
      stats.entered?.();
      await stats.hold;
      await request.token('google');
      return fixture.read(request);
    },
    publish(request) {
      stats.publishes += 1;
      return fixture.publish(request);
    },
  };
}

function segment(options: { readonly live?: boolean; readonly members?: string } = {}): Deps {
  const base = readSegmentConfig({
    AW_SEGMENT_ID: 'alpha',
    AW_IDENTITY: 'local-test',
    AW_SOURCE_MODE: 'fixture',
    AW_LOCAL_TEST_MEMBERS: options.members ?? 'alice@local.test,bob@local.test',
    AW_KEY_DIR: mkdtempSync(join(tmpdir(), 'tw-keys-')),
  });
  return {
    sql,
    config: {
      ...base,
      capabilities: new Set(all),
      ...(options.live === true ? { sourceMode: 'live' as const } : {}),
    },
    gate: createModelGate({
      sql,
      segment: 'alpha',
      model: createScriptedModel(),
      limit: 200,
      now: () => new Date(),
      sleep: () => Promise.resolve(),
    }),
    sources: countingSources(),
    sealer,
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
  stats.reads = 0;
  stats.publishes = 0;
  stats.tokens = 0;
  stats.hold = undefined;
  stats.entered = undefined;
  await sql`truncate wb_tasks, wb_fixture_docs, tw_teammates, tw_conversations, tw_messages, tw_audit, tw_jobs, tw_connections, tw_installations cascade`;
});

async function startTask(d: Deps, member: Member = alice) {
  await seedCatalog(d);
  const teammates = await createStarterTeam(d, member);
  const by = (name: string) => teammates.find((t) => t.name === name)?.id ?? '';
  const { task } = await createTask(d, member, {
    clientRequestId: crypto.randomUUID(),
    workflow: 'research_brief',
    mode: 'manual',
    scope: {
      question: 'Which feature-flag service should we adopt?',
      metrics: null,
      repository: null,
      issueNumber: null,
    },
    resultOwner: by('Coordinator'),
    conversationId: null,
    assignments: [
      { teammateId: by('Research analyst'), brief: 'Prices', sources: ['drive_research'] },
    ],
  });
  const rows = await sql<
    { id: string }[]
  >`select id from tw_assignments where task_id = ${task.id}`;
  return { taskId: task.id, assignmentId: rows.at(0)?.id ?? '' };
}

const driveInput = {
  kind: 'drive_research',
  query: 'Which feature-flag service should we adopt? Prices',
  metrics: null,
  repository: null,
  issueNumber: null,
} as const;

const proposal: PublishProposal = {
  tool: 'google_docs.create',
  account: 'alice@local.test (fixture Docs)',
  destination: 'A new Google Doc in the My Drive of alice@local.test',
  documentTitle: '[aw-m1 alpha] Brief (revision 1)',
  revision: 1,
  contentMarkdown: '# Brief',
  wordCount: 2,
  consequences: ['Creates exactly one new document.'],
};

/** A publication as the approval flow leaves it: the task is publishing and the approval row exists. */
async function approval(
  taskId: string,
  over: { readonly state?: string; readonly digest?: string; readonly subjectRef?: number } = {},
): Promise<string> {
  const id = crypto.randomUUID();
  await sql`update wb_tasks set status = 'publishing', latest_revision = 1 where id = ${taskId}`;
  await sql`
    insert into wb_approvals (id, task_id, proposal, document, payload_sha256, state, requested_at,
      expires_at, subject, subject_ref)
    values (${id}, ${taskId}, ${sql.json(proposal)}, ${sql.json({ markdown: '# Brief' })},
      ${over.digest ?? publishDigest(proposal)}, ${over.state ?? 'approved'}, now(),
      now() + interval '1 hour', 'publish', ${over.subjectRef ?? 1})
  `;
  await sql`
    insert into wb_actions (task_id, approval_id, idempotency_key, status, simulated, updated_at, kind)
    values (${taskId}, ${id}, ${crypto.randomUUID()}, 'intended', true, now(), 'publish')
  `;
  return id;
}

async function disable(d: Deps): Promise<void> {
  await updateInstallation(d, {
    id: 'google',
    expectedGeneration: 1,
    actor: alice.email,
    action: 'installation.disable',
    change: { desiredState: 'disabled' },
  });
}

describe('segment gateway', () => {
  it('runs a read through the registry and wraps provider text as source data', async () => {
    const d = segment();
    const { taskId, assignmentId } = await startTask(d);
    const { result, data } = await readThroughGateway(d, alice, {
      taskId,
      assignmentId,
      token,
      input: driveInput,
    });
    expect(stats.tokens).toBe(1);
    expect(result.items.length).toBeGreaterThan(0);
    expect(data).toHaveLength(result.items.length);
    for (const envelope of data)
      expect(JSON.parse(envelope)).toMatchObject({ kind: 'source-data', authority: 'none' });
  });

  it('denies a fetch once the connector is disabled, without a token or upstream call', async () => {
    const d = segment();
    await bootstrapInstallations(d);
    const { taskId, assignmentId } = await startTask(d);
    await readThroughGateway(d, alice, { taskId, assignmentId, token, input: driveInput });
    stats.reads = 0;
    stats.tokens = 0;
    await disable(d);
    await expect(
      readThroughGateway(d, alice, { taskId, assignmentId, token, input: driveInput }),
    ).rejects.toMatchObject({ code: 'capability_disabled' });
    expect(stats.reads).toBe(0);
    expect(stats.tokens).toBe(0);
    const audits = await sql<
      { outcome: string; detail: unknown }[]
    >`select outcome, detail from tw_audit where action = 'gateway.denied'`;
    expect(audits.map((row) => row.outcome)).toEqual(['capability_disabled']);
    expect(JSON.stringify(audits)).not.toContain('feature-flag');
  });

  it('lets a call already inside its handler finish after a disable', async () => {
    const d = segment();
    await bootstrapInstallations(d);
    const { taskId, assignmentId } = await startTask(d);
    let release: () => void = () => undefined;
    stats.hold = new Promise<void>((resolve) => {
      release = resolve;
    });
    const entered = new Promise<void>((resolve) => {
      stats.entered = resolve;
    });
    const inFlight = readThroughGateway(d, alice, {
      taskId,
      assignmentId,
      token,
      input: driveInput,
    });
    await entered;
    await disable(d);
    release();
    expect((await inFlight).result.items.length).toBeGreaterThan(0);
    await expect(
      readThroughGateway(d, alice, { taskId, assignmentId, token, input: driveInput }),
    ).rejects.toMatchObject({ code: 'capability_disabled' });
  });

  it('denies a write while only read is enabled, whatever the connection scopes are', async () => {
    const d = segment();
    await bootstrapInstallations(d);
    const { taskId } = await startTask(d);
    const approvalId = await approval(taskId);
    await updateInstallation(d, {
      id: 'google',
      expectedGeneration: 1,
      actor: alice.email,
      action: 'installation.set_capabilities',
      change: { capabilities: ['drive.read'] },
    });
    await expect(
      publishThroughGateway(d, alice, { taskId, approvalId, token }),
    ).rejects.toMatchObject({ code: 'capability_disabled' });
    expect(stats.publishes).toBe(0);
    expect(stats.tokens).toBe(0);
    const actions = await sql<
      { attempts: number }[]
    >`select attempts from wb_actions where approval_id = ${approvalId}`;
    expect(actions.at(0)?.attempts).toBe(0);
  });

  it('publishes only the exact approved digest, state and revision', async () => {
    const d = segment();
    const { taskId } = await startTask(d);
    const approved = await approval(taskId);
    const { published, proposal: used } = await publishThroughGateway(d, alice, {
      taskId,
      approvalId: approved,
      token,
    });
    expect(used).toEqual(proposal);
    expect(published.documentId).not.toBe('');
    expect(stats.publishes).toBe(1);
    const refused = [
      await approval(taskId, { digest: 'f'.repeat(64) }),
      await approval(taskId, { state: 'pending' }),
      await approval(taskId, { state: 'void' }),
      await approval(taskId, { subjectRef: 2 }),
    ];
    for (const approvalId of refused)
      await expect(
        publishThroughGateway(d, alice, { taskId, approvalId, token }),
      ).rejects.toMatchObject({ code: 'approval_invalid' });
    await expect(
      publishThroughGateway(d, alice, { taskId, approvalId: crypto.randomUUID(), token }),
    ).rejects.toMatchObject({ code: 'approval_invalid' });
    expect(stats.publishes).toBe(1);
  });

  it('does not accept an approval that belongs to another task', async () => {
    const d = segment();
    const first = await startTask(d);
    const second = await startTask(d);
    const foreign = await approval(first.taskId);
    await sql`update wb_tasks set status = 'publishing', latest_revision = 1 where id = ${second.taskId}`;
    await expect(
      publishThroughGateway(d, alice, { taskId: second.taskId, approvalId: foreign, token }),
    ).rejects.toMatchObject({ code: 'approval_invalid' });
    expect(stats.publishes).toBe(0);
  });

  it('rejects forged identity keys through the strict input schema', async () => {
    const d = segment();
    const { taskId, assignmentId } = await startTask(d);
    const approvalId = await approval(taskId);
    for (const forged of [
      { ownerSub: bob.sub },
      { actor: bob.email },
      { segment: 'beta' },
      { accessToken: 'stolen' },
    ]) {
      await expect(
        invoke(d, alice, {
          tool: 'drive.read',
          taskId,
          assignmentId,
          token,
          input: { ...driveInput, ...forged },
        }),
      ).rejects.toMatchObject({ code: 'invalid_input' });
      await expect(
        invoke(d, alice, {
          tool: 'docs.publish',
          taskId,
          token,
          input: { approvalId, ...forged },
        }),
      ).rejects.toMatchObject({ code: 'invalid_input' });
    }
    expect(stats.reads + stats.publishes + stats.tokens).toBe(0);
  });

  it('rejects a source kind that the tool does not cover', async () => {
    const d = segment();
    const { taskId, assignmentId } = await startTask(d);
    await expect(
      invoke(d, alice, {
        tool: 'drive.read',
        taskId,
        assignmentId,
        token,
        input: { ...driveInput, kind: 'github_code' },
      }),
    ).rejects.toMatchObject({ code: 'invalid_input' });
  });

  it('fails closed for a tool that is not in the registry', async () => {
    const d = segment();
    const { taskId, assignmentId } = await startTask(d);
    for (const tool of ['drive.write', 'files.read', '', '__proto__'])
      await expect(
        invoke(d, alice, { tool, taskId, assignmentId, token, input: driveInput }),
      ).rejects.toMatchObject({ code: 'unknown_tool' });
    expect(stats.reads + stats.tokens).toBe(0);
  });

  it('makes no upstream call for a missing or revoked connection', async () => {
    const live = segment({ live: true });
    const { taskId, assignmentId } = await startTask(segment());
    const read = () =>
      readThroughGateway(live, alice, { taskId, assignmentId, token, input: driveInput });
    await expect(read()).rejects.toMatchObject({ code: 'not_connected' });
    const connect = (status: string) => sql`
      insert into tw_connections (owner_sub, provider, account, scopes, sealed_access, access_expires_at,
        status, connected_at, updated_at)
      values (${alice.sub}, 'google', 'alice@local.test', ${sql.json(['drive.readonly'])},
        ${sealer.seal('google-access')}, now() + interval '1 hour', ${status}, now(), now())
      on conflict (owner_sub, provider) do update set status = excluded.status
    `;
    await connect('revoked');
    await expect(read()).rejects.toMatchObject({ code: 'not_connected' });
    expect(stats.reads + stats.tokens).toBe(0);
    await connect('active');
    expect((await read()).result.items.length).toBeGreaterThan(0);
  });

  it('denies a member who left the segment and a task that is not theirs', async () => {
    const d = segment();
    const { taskId, assignmentId } = await startTask(d);
    const call = { taskId, assignmentId, token, input: driveInput };
    await expect(readThroughGateway(d, bob, call)).rejects.toMatchObject({ code: 'not_found' });
    await expect(
      readThroughGateway(segment({ members: 'bob@local.test' }), alice, call),
    ).rejects.toMatchObject({ code: 'not_entitled' });
    expect(stats.reads + stats.tokens).toBe(0);
  });
});
