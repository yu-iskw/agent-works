/* eslint-disable security/detect-non-literal-fs-filename -- test-owned temporary package copies */
import { randomUUID } from 'node:crypto';
import { appendFile, cp, mkdtemp, rm, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import postgres from 'postgres';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { createAdmissionService } from '../../../admission/postgres-admission.js';
import { applyStandingGrantMigration } from '../../../authority-lifecycle/migration.js';
import { createPostgresGrantStore } from '../../../authority-lifecycle/postgres-store.js';
import { startDisposablePostgres } from '../../../ledger/disposable-postgres.js';
import { applyWorkbenchMigration } from '../../../workbench/migration.js';
import { createStarterTeam, seedCatalog } from '../../catalog.js';
import { applyGraphMigration } from '../../graph-migration.js';
import { alice, segmentDeps } from '../../graph-test-support.js';
import { bootstrapInstallations, segmentCapabilities } from '../../installations.js';
import { parseAgentRegistry } from '../../mcp-task/index.js';
import { startReferenceAgent } from '../../mcp-task/reference-http.js';
import { createRoutes } from '../../routes.js';
import { createTeamworkRuntime } from '../../runtime.js';
import {
  applySkillPackagesMigration,
  createSkillPackageStore,
  syncCuratedPackages,
} from '../../skill-packages/index.js';
import { createWorker } from '../../worker.js';
import { applyBotsMigration } from '../migration.js';
import { createBotService } from '../service.js';

import { createRunCommands } from './commands.js';
import { registerBotExecution } from './engine.js';
import { createBotGrantRoutes } from './grant-routes.js';
import { applyBotExecutionMigration } from './migration.js';
import { createBotRunRoutes } from './run-routes.js';
import { createStartBotRun } from './start.js';
import { ADMIN_TRANSITIONS } from './types.js';
import { runView } from './views.js';

import type { StartBotRunResult } from './start.js';
import type { ExecutionOptions } from './types.js';
import type { Caller } from '../../../auth/iap.js';
import type { Member, Request } from '../../context.js';
import type { ApprovedAgent } from '../../mcp-task/index.js';
import type { BotDefinition } from '@agent-works/domain';

let database: Awaited<ReturnType<typeof startDisposablePostgres>>;
let agent: Awaited<ReturnType<typeof startReferenceAgent>>;
let sql: postgres.Sql;
let options: ExecutionOptions;
let execution: ReturnType<typeof registerBotExecution>;
let commands: ReturnType<typeof createRunCommands>;
let teammateId: string;
let clock: number;
let skillRoot: string;
let skillDigest: string;
let approved: ApprovedAgent;
let generated: string[];
let pauseModel: (() => Promise<void>) | undefined;
const bob: Member = { sub: 'local-test:bob', email: 'bob@local.test' };

beforeAll(async () => {
  database = await startDisposablePostgres();
  sql = postgres(database.url, { max: 20, onnotice: () => undefined });
  await applyWorkbenchMigration(sql);
  await applyGraphMigration(sql);
  await applyBotsMigration(sql);
  await createAdmissionService({ sql, leaseMs: 300_000 });
  await applyStandingGrantMigration(sql);
  await applySkillPackagesMigration(sql);
  await applyBotExecutionMigration(sql);
  await applyBotExecutionMigration(sql);
}, 60_000);
afterAll(async () => {
  await agent.close();
  await sql.end({ timeout: 1 });
  await database.stop();
});
beforeEach(async () => {
  if (typeof agent !== 'undefined') await agent.close();
  if (skillRoot) await rm(skillRoot, { recursive: true, force: true });
  clock = Date.now();
  agent = await startReferenceAgent({ now: () => clock, completionMs: 100 });
  approved = {
    agentId: 'reference-research-agent',
    displayName: 'Reference',
    protocol: 'mcp',
    contract: 'aw.task.v1',
    endpoint: agent.endpoint,
    allowedHosts: [new URL(agent.endpoint).host],
    supports: { cancel: true, lookupByIdempotencyKey: true, reportsCost: true },
    maxInputBytes: 65536,
    maxOutputBytes: 65536,
    callTimeoutMs: 2000,
    dataClassification: 'INTERNAL',
  };
  await sql`truncate tw_installations, wb_tasks, wb_model_calls, tw_teammates, tw_conversations, tw_messages, tw_audit, tw_jobs, tw_skill_packages, admission_reservations, admission_limits, tw_standing_grants, tw_standing_grant_audit restart identity cascade`;
  generated = [];
  pauseModel = undefined;
  const deps = segmentDeps(sql, {
    now: () => new Date(clock),
    model: {
      mode: 'stub',
      modelId: 'scripted-ui-review',
      generate: async (request) => {
        generated.push(request.system);
        await pauseModel?.();
        return Promise.resolve({
          text: `Skill output ${request.prompt}`,
          modelVersion: 'scripted-ui-review',
          latencyMs: 1,
          promptTokens: 10,
          outputTokens: 20,
        });
      },
    },
  });
  await seedCatalog(deps);
  await bootstrapInstallations(deps);
  teammateId = (await createStarterTeam(deps, alice))[0].id;
  await sql`update tw_teammates set capability_requests = '["drive.read"]'::jsonb where id = ${teammateId}`;
  skillRoot = await mkdtemp(join(tmpdir(), 'bot-exec-skills-'));
  await cp(
    fileURLToPath(new URL('../../skill-packages/curated/brief-writer/', import.meta.url)),
    join(skillRoot, 'brief-writer'),
    { recursive: true },
  );
  const instructionsPath = join(
    skillRoot,
    'brief-writer',
    'skills',
    'summarize-findings',
    'SKILL.md',
  );
  await writeFile(
    instructionsPath,
    (await readFile(instructionsPath, 'utf8')).replace(
      'allowed-tools: files.read',
      'allowed-tools: drive.read',
    ),
  );
  const skills = createSkillPackageStore(sql);
  const loaded = await syncCuratedPackages({ store: skills, root: skillRoot });
  skillDigest = loaded[0].report.digest ?? '';
  await skills.activate('brief-writer', '1.0.0', 'test');
  const registry = parseAgentRegistry([approved], { allowLoopback: true });
  const service = createBotService(deps, async () => ({
    segmentCapabilities: await segmentCapabilities(deps),
    approvedAgents: registry,
    skills,
  }));
  options = {
    deps,
    service,
    registry,
    skills,
    grants: createPostgresGrantStore(sql),
    admission: await createAdmissionService({ sql, leaseMs: 300_000, now: deps.now }),
    pollMs: 1,
  };
  execution = registerBotExecution(options);
  commands = createRunCommands(options, execution);
});
function definition(
  mode: BotDefinition['approvals']['mode'] = 'checkpoints_only',
  instruction = 'Summarize findings',
): BotDefinition {
  return {
    apiVersion: 'agent-works.bot/v1',
    name: 'Research bot',
    purpose: 'Read and summarize',
    planning: { mode: 'fixed' },
    workflow: {
      steps: [
        {
          id: 'read',
          title: 'Read',
          kind: 'connector_read',
          dependsOn: [],
          capability: 'drive.read',
          query: 'Research notes',
        },
        {
          id: 'skill',
          title: 'Skill',
          kind: 'skill',
          dependsOn: ['read'],
          inputs: ['read'],
          skill: {
            packageId: 'brief-writer',
            version: '1.0.0',
            digest: skillDigest,
            name: 'summarize-findings',
          },
        },
        {
          id: 'delegate',
          title: 'Delegate',
          kind: 'mcp_delegate',
          dependsOn: ['skill'],
          inputs: ['skill'],
          agent: { agentId: approved.agentId, protocol: 'mcp' },
          instruction,
          timeoutSeconds: 10,
        },
        {
          id: 'checkpoint',
          title: 'Review',
          kind: 'approval',
          dependsOn: ['delegate'],
          prompt: 'Accept result?',
        },
        {
          id: 'result',
          title: 'Result',
          kind: 'result',
          dependsOn: ['checkpoint', 'delegate'],
          from: 'delegate',
        },
      ],
    },
    triggers: [{ kind: 'manual' }, { kind: 'event', source: 'test', eventType: 'changed' }],
    approvals: { mode },
    limits: {
      maxConcurrentRunsPerBot: 1,
      maxConcurrentRunsPerUser: 5,
      runTimeoutMinutes: 60,
      maxCostMicros: null,
    },
    result: { destination: 'inbox' },
  };
}
async function publish(def = definition()) {
  const draft = await options.service.createDraft(alice, teammateId, def, { source: 'api' });
  await options.service.publish(alice, teammateId, draft);
  await sql`update tw_bots set owner_email = ${alice.email} where teammate_id = ${teammateId}`;
}
function taskId(result: StartBotRunResult) {
  if (result.kind !== 'started' && result.kind !== 'duplicate')
    throw new Error(JSON.stringify(result));
  return result.taskId;
}
async function start() {
  return taskId(
    await createStartBotRun(options)({
      teammateId,
      trigger: { kind: 'manual' },
      initiatedBy: alice.sub,
      clientRequestId: randomUUID(),
    }),
  );
}
async function drain() {
  await createWorker(options.deps, (error) => {
    throw error;
  }).drain();
}
async function tick() {
  clock += 200;
  await drain();
}
async function reachCheckpoint(id: string) {
  await drain();
  await tick();
  return runView(options, alice, id);
}
async function approve(id: string) {
  const approval = (await runView(options, alice, id)).approvals.find((a) => a.state === 'pending');
  if (!approval) throw new Error('missing_approval');
  await commands.approve(alice, id, approval.id, {
    decision: 'approve',
    actionDigest: approval.actionDigest,
  });
}
function request(body: object): Request {
  return {
    method: 'POST',
    path: '',
    query: new URLSearchParams(),
    headers: {},
    body: Buffer.from(JSON.stringify(body)),
  };
}
async function grant(maxRuns = 5, budgetMicros: number | null = null) {
  const route = createBotGrantRoutes(options)[0];
  await route.handle(
    {
      deps: options.deps,
      member: alice,
      request: request({
        revision: 1,
        expiresAt: new Date(clock + 3600_000).toISOString(),
        maxRuns,
        budgetMicros,
      }),
    },
    [teammateId],
  );
  const all = await options.grants.list();
  return all[0];
}

describe('durable bot execution', () => {
  it('runs connector, pinned skill, real MCP, checkpoint and inbox result', async () => {
    await publish();
    const id = await start();
    const waiting = await reachCheckpoint(id);
    expect(waiting.lastError).toBeNull();
    expect(waiting.status).toBe('waiting_approval');
    expect(waiting.steps.map((s) => s.status)).toEqual([
      'succeeded',
      'succeeded',
      'succeeded',
      'waiting_approval',
      'pending',
    ]);
    expect(generated[0]).toContain('Allowed tools: drive.read');
    await approve(id);
    await drain();
    const view = await runView(options, alice, id);
    expect(view.status).toBe('completed');
    expect(view.result?.text).toContain('Skill output');
    expect(view.cost).toMatchObject({ completeness: 'partial', reportedMicros: 1234 });
    expect(await options.admission.inFlight('bot', teammateId)).toBe(0);
    expect(agent.calls.filter((c) => c === 'task.submit')).toHaveLength(1);
    expect(
      await sql`select 1 from tw_inbox where task_id = ${id} and kind = 'completed' and state = 'open'`,
    ).toHaveLength(1);
  });
  it('denies a changed skill package before creating a run', async () => {
    await publish();
    await appendFile(join(skillRoot, 'brief-writer', 'plugin.json'), ' ');
    expect(
      await createStartBotRun(options)({
        teammateId,
        trigger: { kind: 'manual' },
        initiatedBy: alice.sub,
        clientRequestId: randomUUID(),
      }),
    ).toEqual({ kind: 'denied', code: 'digest_mismatch' });
    expect(await sql`select 1 from tw_bot_runs`).toHaveLength(0);
  });
  it('binds per-run approval to owner and exact digest', async () => {
    await publish(definition('per_run'));
    const id = await start();
    const view = await runView(options, alice, id);
    const a = view.approvals[0];
    await expect(
      commands.approve(bob, id, a.id, { decision: 'approve', actionDigest: a.actionDigest }),
    ).rejects.toMatchObject({ code: 'wrong_actor' });
    await expect(
      commands.approve(alice, id, a.id, { decision: 'approve', actionDigest: '0'.repeat(64) }),
    ).rejects.toMatchObject({ code: 'stale_approval' });
    await drain();
    expect(agent.calls).toHaveLength(0);
    await approve(id);
    expect((await reachCheckpoint(id)).status).toBe('waiting_approval');
  });
  it('rejects expired approval and recovery ends the run', async () => {
    await publish(definition('per_run'));
    const id = await start();
    const a = (await runView(options, alice, id)).approvals[0];
    await sql`update wb_approvals set expires_at = ${new Date(clock - 1)} where id = ${a.id}`;
    await expect(
      commands.approve(alice, id, a.id, { decision: 'approve', actionDigest: a.actionDigest }),
    ).rejects.toMatchObject({ code: 'stale_approval' });
    await execution.recover();
    expect((await runView(options, alice, id)).status).toBe('failed');
  });
  it('decline fails the run and blocks downstream work', async () => {
    await publish(definition('per_run'));
    const id = await start();
    const a = (await runView(options, alice, id)).approvals[0];
    await commands.approve(alice, id, a.id, { decision: 'decline', actionDigest: a.actionDigest });
    const view = await runView(options, alice, id);
    expect(view.status).toBe('failed');
    expect(view.steps.every((s) => s.status === 'blocked')).toBe(true);
  });
  it('checkpoint rejects changed upstream input', async () => {
    await publish();
    const id = await start();
    const view = await reachCheckpoint(id);
    const a = view.approvals[0];
    await sql`update tw_bot_steps set output = '{"text":"changed exact action"}'::jsonb where task_id = ${id} and step_id = 'delegate'`;
    await expect(
      commands.approve(alice, id, a.id, { decision: 'approve', actionDigest: a.actionDigest }),
    ).rejects.toMatchObject({ code: 'stale_approval' });
  });
  it('membership removal during approval prevents continuation', async () => {
    await publish(definition('per_run'));
    const id = await start();
    if (options.deps.config.members instanceof Set) options.deps.config.members.delete(alice.email);
    await approve(id);
    expect((await runView(options, alice, id)).lastError?.code).toBe('membership_revoked');
    expect(agent.calls).toHaveLength(0);
  });
  it('unbound background identities and read-only owners fail closed', async () => {
    await publish();
    await sql`update tw_bots set owner_email = null where teammate_id = ${teammateId}`;
    const startBotRun = createStartBotRun(options);
    expect(
      await startBotRun({
        teammateId,
        trigger: {
          kind: 'event',
          ref: 'event:test:1',
          source: 'test',
          eventType: 'changed',
          payload: {},
        },
        initiatedBy: 'event:test:1',
        clientRequestId: randomUUID(),
      }),
    ).toEqual({ kind: 'denied', code: 'identity_unbound' });
    await sql`update tw_bots set owner_email = ${alice.email} where teammate_id = ${teammateId}`;
    if (options.deps.config.readOnlyMembers instanceof Set)
      options.deps.config.readOnlyMembers.add(alice.email);
    expect(
      await startBotRun({
        teammateId,
        trigger: { kind: 'manual' },
        initiatedBy: alice.sub,
        clientRequestId: randomUUID(),
      }),
    ).toEqual({ kind: 'denied', code: 'read_only_member' });
  });
  it('lost submit response is looked up without submitting twice', async () => {
    await publish(definition('checkpoints_only', '[reference:drop-submit] recover me'));
    const id = await start();
    await reachCheckpoint(id);
    expect(agent.calls.filter((c) => c === 'task.submit')).toHaveLength(1);
    expect(agent.calls).toContain('task.lookup');
    expect((await runView(options, alice, id)).steps[2].status).toBe('succeeded');
  });
  it('lost response without lookup becomes uncertain and never resubmits', async () => {
    approved.supports.lookupByIdempotencyKey = false;
    options.registry = parseAgentRegistry([approved], { allowLoopback: true });
    execution = registerBotExecution(options);
    await publish(definition('checkpoints_only', '[reference:drop-submit] uncertain'));
    const id = await start();
    await drain();
    await tick();
    expect((await runView(options, alice, id)).status).toBe('outcome_uncertain');
    await tick();
    expect(agent.calls.filter((c) => c === 'task.submit')).toHaveLength(1);
  });
  it('a fresh worker resumes the stored handle without resubmitting', async () => {
    await publish();
    const id = await start();
    await drain();
    expect((await runView(options, alice, id)).status).toBe('waiting_external');
    execution = registerBotExecution(options);
    await execution.recover();
    await tick();
    expect((await runView(options, alice, id)).status).toBe('waiting_approval');
    expect(agent.calls.filter((c) => c === 'task.submit')).toHaveLength(1);
  });
  it('two manual starts compete for one admission slot', async () => {
    await publish();
    const input = { teammateId, trigger: { kind: 'manual' as const }, initiatedBy: alice.sub };
    const results = await Promise.all([
      createStartBotRun(options)({ ...input, clientRequestId: randomUUID() }),
      createStartBotRun(options)({ ...input, clientRequestId: randomUUID() }),
    ]);
    expect(results.filter((r) => r.kind === 'started')).toHaveLength(1);
    expect(results.filter((r) => r.kind === 'denied')).toEqual([
      { kind: 'denied', code: 'admission_denied' },
    ]);
    expect(await sql`select 1 from tw_bot_runs`).toHaveLength(1);
  });
  it('trigger delivery is idempotent and admission denial defers background work', async () => {
    await publish();
    const input = {
      teammateId,
      trigger: {
        kind: 'event' as const,
        ref: 'event:test:2',
        source: 'test',
        eventType: 'changed',
        payload: {},
      },
      initiatedBy: 'event:test:2',
      clientRequestId: randomUUID(),
    };
    const run = await createStartBotRun(options)(input);
    expect(await createStartBotRun(options)(input)).toEqual({
      kind: 'duplicate',
      taskId: taskId(run),
    });
    expect(
      await createStartBotRun(options)({
        ...input,
        trigger: { ...input.trigger, ref: 'event:test:3' },
        clientRequestId: randomUUID(),
      }),
    ).toEqual({ kind: 'deferred', code: 'bot_cap' });
  });
  it('holder lease expiry releases admission and ends an abandoned wait', async () => {
    await publish(definition('per_run'));
    const id = await start();
    clock += 300_001;
    await execution.recover();
    expect((await runView(options, alice, id)).status).toBe('failed');
    expect(await options.admission.inFlight('bot', teammateId)).toBe(0);
  });
  it('active standing grant works and maxRuns excludes a second run', async () => {
    await publish(definition('standing_grant'));
    await grant(1);
    const id = await start();
    await reachCheckpoint(id);
    await approve(id);
    await drain();
    expect((await runView(options, alice, id)).status).toBe('completed');
    expect(
      await createStartBotRun(options)({
        teammateId,
        trigger: { kind: 'manual' },
        initiatedBy: alice.sub,
        clientRequestId: randomUUID(),
      }),
    ).toEqual({ kind: 'denied', code: 'grant_invalid' });
  });
  it('revoked grant stops the next continuation', async () => {
    await publish(definition('standing_grant'));
    const g = await grant();
    const id = await start();
    await reachCheckpoint(id);
    await options.grants.revokeTree({
      grantId: g.grantId,
      by: alice.sub,
      at: new Date(clock).toISOString(),
      reason: 'test',
    });
    await approve(id);
    expect((await runView(options, alice, id)).lastError?.code).toBe('grant_invalid');
  });
  it('expired grant is denied before any run', async () => {
    await publish(definition('standing_grant'));
    await grant();
    clock += 3600_001;
    expect(
      await createStartBotRun(options)({
        teammateId,
        trigger: { kind: 'manual' },
        initiatedBy: alice.sub,
        clientRequestId: randomUUID(),
      }),
    ).toEqual({ kind: 'denied', code: 'grant_invalid' });
  });
  it('removing the installation before delegation denies the effect', async () => {
    await publish(definition('per_run'));
    const id = await start();
    await sql`update tw_installations set desired_state = 'disabled' where item_id = 'google'`;
    await approve(id);
    await drain();
    expect((await runView(options, alice, id)).status).toBe('failed');
    expect(agent.calls).toHaveLength(0);
  });
  it('removing the approved agent before delegation denies the effect', async () => {
    await publish(definition('per_run'));
    const id = await start();
    options.registry = parseAgentRegistry([], { allowLoopback: true });
    await approve(id);
    await drain();
    expect((await runView(options, alice, id)).lastError?.code).toBe('unknown_agent');
  });
  it('tool failures expose safe codes only', async () => {
    await publish(definition('checkpoints_only', '[reference:tool-error] fail'));
    const id = await start();
    await drain();
    const view = await runView(options, alice, id);
    expect(view.status).toBe('outcome_uncertain');
    expect(JSON.stringify(view)).not.toContain('upstream secret');
  });
  it('remote timeout requests cancellation', async () => {
    await publish(definition('checkpoints_only', '[reference:never] wait'));
    const id = await start();
    await drain();
    clock += 11_000;
    await drain();
    const view = await runView(options, alice, id);
    expect(view.status).toBe('failed');
    expect(view.steps[2].external?.cancel).toBe('confirmed');
  });
  it.each([true, false])('cancel during delegation with support=%s', async (support) => {
    approved.supports.cancel = support;
    options.registry = parseAgentRegistry([approved], { allowLoopback: true });
    execution = registerBotExecution(options);
    commands = createRunCommands(options, execution);
    await publish(definition('checkpoints_only', '[reference:never] wait'));
    const id = await start();
    await drain();
    await commands.cancel(alice, id);
    await tick();
    const view = await runView(options, alice, id);
    expect(view.status).toBe(support ? 'cancelled' : 'outcome_uncertain');
    expect(view.steps[2].external?.cancel).toBe(support ? 'confirmed' : 'unsupported');
    clock += 20_000;
    await drain();
    expect((await runView(options, alice, id)).status).toBe(view.status);
  });
  it('cancel voids pending approvals and a late decision cannot restart the run', async () => {
    await publish(definition('per_run'));
    const id = await start();
    const a = (await runView(options, alice, id)).approvals[0];
    await commands.cancel(alice, id);
    await commands.approve(alice, id, a.id, { decision: 'approve', actionDigest: a.actionDigest });
    await drain();
    const view = await runView(options, alice, id);
    expect(view.status).toBe('cancelled');
    expect(view.approvals[0].state).toBe('void');
    expect(agent.calls).toHaveLength(0);
  });
  it('unknown MCP cost remains unknown, never zero', async () => {
    await publish(definition('checkpoints_only', '[reference:unknown-cost] price missing'));
    const id = await start();
    const view = await reachCheckpoint(id);
    expect(view.cost.completeness).toBe('unknown');
    expect(view.cost.reportedMicros).toBeNull();
    expect(view.cost.unknownItems).toContain('mcp:delegate:0');
  });
  it('zero run budget prevents paid dispatch', async () => {
    const def = definition();
    def.limits.maxCostMicros = 0;
    await publish(def);
    const id = await start();
    await drain();
    expect((await runView(options, alice, id)).lastError?.code).toBe('cost_budget');
    expect(generated).toHaveLength(0);
    expect(agent.calls).toHaveLength(0);
  });
  it('two workers and a duplicate delivery create one external task', async () => {
    await publish();
    const id = await start();
    const one = createWorker(options.deps, (error) => {
      throw error;
    });
    const two = createWorker(options.deps, (error) => {
      throw error;
    });
    await Promise.all([one.drain(), two.drain()]);
    await sql`insert into tw_jobs(task_id,kind,ref,state,created_at,updated_at) values(${id},'bot_step',${`${id}:delegate`},'queued',${new Date(clock)},${new Date(clock)}) on conflict (kind,ref) where state in ('queued','running') do nothing`;
    await tick();
    expect(agent.calls.filter((c) => c === 'task.submit')).toHaveLength(1);
  });
  it('stopping and starting worker loops resumes polling with one submit', async () => {
    await publish();
    const id = await start();
    const first = createWorker(
      options.deps,
      (error) => {
        throw error;
      },
      5,
    );
    first.start();
    try {
      await expect
        .poll(async () => (await runView(options, alice, id)).status)
        .toBe('waiting_external');
    } finally {
      await first.stop();
    }
    clock += 500;
    const next = createWorker(
      options.deps,
      (error) => {
        throw error;
      },
      5,
    );
    next.start();
    try {
      await expect
        .poll(async () => (await runView(options, alice, id)).status)
        .toBe('waiting_approval');
    } finally {
      await next.stop();
    }
    expect(agent.calls.filter((c) => c === 'task.submit')).toHaveLength(1);
  });
  it('an expired job owner cannot settle its model output', async () => {
    let unblock: () => void = () => undefined;
    pauseModel = () =>
      new Promise<void>((resolve) => {
        unblock = resolve;
      });
    await publish();
    const id = await start();
    const running = drain();
    await expect.poll(() => generated.length).toBe(1);
    await sql`update tw_jobs set lease_token=gen_random_uuid(),lease_until=now()-interval '1 second' where task_id=${id} and kind='bot_step' and state='running'`;
    unblock();
    await running;
    const view = await runView(options, alice, id);
    expect(view.steps[1].outputSummary).toBeNull();
    expect(agent.calls).toHaveLength(0);
  });
  it('manual routes bind verified email and enforce owner, CSRF and shape', async () => {
    await publish(definition('per_run'));
    await sql`update tw_bots set owner_email=null where teammate_id=${teammateId}`;
    const route = createRoutes(
      options.deps,
      () =>
        Promise.resolve<Caller>({
          __brand: 'VerifiedCaller',
          sub: alice.sub,
          email: alice.email,
          assertion: 'verified',
        }),
      () => Promise.resolve({}),
      createBotRunRoutes(options, execution),
    );
    const req = {
      ...request({ clientRequestId: randomUUID() }),
      path: `/v1/teamwork/bots/${teammateId}/runs`,
    };
    expect((await route(req)).status).toBe(403);
    const response = await route({ ...req, headers: { 'x-csrf-token': 'yes' } });
    expect(response.status).toBe(201);
    const runId = (await sql<{ task_id: string }[]>`select task_id from tw_bot_runs`)[0].task_id;
    const approval = (await runView(options, alice, runId)).approvals[0];
    const stale = await route({
      ...request({ decision: 'approve', actionDigest: 'stale' }),
      headers: { 'x-csrf-token': 'yes' },
      path: `/v1/teamwork/bot-runs/${runId}/approvals/${approval.id}`,
    });
    expect(stale.status).toBe(409);
    const get = await route({
      ...request({}),
      method: 'GET',
      path: `/v1/teamwork/bots/${teammateId}/runs`,
    });
    expect(get.status).toBe(200);
    expect(
      await sql`select 1 from tw_bots where teammate_id=${teammateId} and owner_email=${alice.email}`,
    ).toHaveLength(1);
    await expect(
      runView(
        options,
        bob,
        (await sql<{ task_id: string }[]>`select task_id from tw_bot_runs`)[0].task_id,
      ),
    ).rejects.toMatchObject({ code: 'not_found' });
  });
  it('flag off returns 404 and refuses the runtime start port', async () => {
    const runtime = await createTeamworkRuntime({
      sql,
      config: options.deps.config,
      env: {},
      verify: () =>
        Promise.resolve<Caller>({
          __brand: 'VerifiedCaller',
          sub: alice.sub,
          email: alice.email,
          assertion: 'verified',
        }),
    });
    const response = await runtime.route({
      ...request({ clientRequestId: randomUUID() }),
      headers: { 'x-csrf-token': 'yes' },
      path: `/v1/teamwork/bots/${teammateId}/runs`,
    });
    expect(response.status).toBe(404);
    expect(
      await runtime.startBotRun({
        teammateId,
        trigger: { kind: 'manual' },
        initiatedBy: alice.sub,
        clientRequestId: randomUUID(),
      }),
    ).toEqual({ kind: 'denied', code: 'feature_disabled' });
    await runtime.stop();
  });
  it('reported external cost without model calls is complete', async () => {
    const def = definition();
    def.workflow.steps = def.workflow.steps.filter((s) => s.kind !== 'skill');
    const delegate = def.workflow.steps.find((s) => s.kind === 'mcp_delegate');
    if (delegate?.kind === 'mcp_delegate') {
      delegate.dependsOn = ['read'];
      delegate.inputs = ['read'];
    }
    await publish(def);
    const id = await start();
    const view = await reachCheckpoint(id);
    expect(view.cost).toMatchObject({
      completeness: 'complete',
      reportedMicros: 1234,
      unknownItems: [],
    });
  });
  it('skill tools only narrow even if a resolver advertises wider tools', async () => {
    await publish();
    const original = options.skills;
    options.skills = {
      resolve: async (ref) => {
        const resolved = await original.resolve(ref);
        return resolved.ok
          ? {
              ...resolved,
              skill: { ...resolved.skill, allowedTools: ['drive.read', 'docs.publish'] },
            }
          : resolved;
      },
    };
    const id = await start();
    await reachCheckpoint(id);
    expect(generated[0]).toContain('Allowed tools: drive.read.');
    expect(generated[0]).not.toContain('Allowed tools: drive.read, docs.publish');
  });
  it('owner retry reacquires admission and increments the attempt', async () => {
    await publish();
    const id = await start();
    await sql`update tw_jobs set state='cancelled' where task_id=${id}`;
    await sql`update tw_bot_steps set status='failed',error_code='worker_lost' where task_id=${id} and step_id='read'`;
    await sql`update wb_tasks set status='failed' where id=${id}`;
    await options.admission.release(id, 'failed');
    await commands.retry(alice, id, 'read');
    await reachCheckpoint(id);
    const view = await runView(options, alice, id);
    expect(view.steps[0].attempt).toBe(1);
    expect(view.status).toBe('waiting_approval');
  });
  it('uncertain resolution is audited and never resubmits or invents output', async () => {
    approved.supports.lookupByIdempotencyKey = false;
    options.registry = parseAgentRegistry([approved], { allowLoopback: true });
    execution = registerBotExecution(options);
    commands = createRunCommands(options, execution);
    await publish(definition('checkpoints_only', '[reference:drop-submit] unknown'));
    const id = await start();
    await drain();
    await commands.resolve(alice, id, 'delegate', {
      outcome: 'succeeded',
      note: 'Checked the remote record',
    });
    const view = await runView(options, alice, id);
    expect(view.steps[2]).toMatchObject({
      status: 'succeeded',
      terminalReason: 'resolved_by_owner',
      outputSummary: null,
    });
    expect(view.steps[4]).toMatchObject({
      status: 'blocked',
      terminalReason: 'resolved_without_output',
    });
    await tick();
    expect(agent.calls.filter((c) => c === 'task.submit')).toHaveLength(1);
    expect(
      await sql`select 1 from tw_audit where task_id=${id} and action='bot.resolve'`,
    ).toHaveLength(1);
  });
  it('finite budget reserves unknown model cost and refuses a later paid step', async () => {
    const def = definition();
    def.limits.maxCostMicros = 10000;
    await publish(def);
    const id = await start();
    await drain();
    expect((await runView(options, alice, id)).lastError?.code).toBe('cost_budget');
    expect(generated).toHaveLength(1);
    expect(agent.calls).toHaveLength(0);
  });
  it('late MCP completion after cancellation is recorded without advancing', async () => {
    let unblock: () => void = () => undefined;
    let blocked = false;
    const original = options.deps.fetch;
    options.deps = {
      ...options.deps,
      fetch: async (input, init) => {
        const response = await original(input, init);
        if (typeof init?.body === 'string' && init.body.includes('task.result')) {
          blocked = true;
          await new Promise<void>((resolve) => {
            unblock = resolve;
          });
        }
        return response;
      },
    };
    execution = registerBotExecution(options);
    commands = createRunCommands(options, execution);
    await publish();
    const id = await start();
    await drain();
    clock += 200;
    const completing = drain();
    await expect.poll(() => blocked).toBe(true);
    await commands.cancel(alice, id);
    unblock();
    await completing;
    await tick();
    const view = await runView(options, alice, id);
    expect(view.status).toBe('cancelled');
    expect(view.result).toBeNull();
    expect(view.steps[2].outputSummary).toBeNull();
    expect(
      await sql`select 1 from wb_events where task_id=${id} and type='bot.late_result_ignored'`,
    ).toHaveLength(1);
  });
  it('delegation timeout begins at the step boundary', async () => {
    pauseModel = () => {
      clock += 20_000;
      return Promise.resolve();
    };
    await publish();
    const id = await start();
    await drain();
    expect((await runView(options, alice, id)).status).toBe('waiting_external');
    expect(agent.calls.filter((c) => c === 'task.submit')).toHaveLength(1);
  });
  it('zero standing-grant budget denies paid runs at start', async () => {
    await publish(definition('standing_grant'));
    await grant(5, 0);
    expect(
      await createStartBotRun(options)({
        teammateId,
        trigger: { kind: 'manual' },
        initiatedBy: alice.sub,
        clientRequestId: randomUUID(),
      }),
    ).toEqual({ kind: 'denied', code: 'grant_invalid' });
    expect(await sql`select 1 from tw_bot_runs`).toHaveLength(0);
  });
  it('pins the explicit admin transitions', () => {
    expect(ADMIN_TRANSITIONS).toEqual({
      step: { failed: ['ready'], outcome_uncertain: ['succeeded', 'failed'] },
      run: { failed: ['running'] },
    });
  });
});
