import { IAP_ASSERTION_HEADER } from '@agent-works/domain';
import postgres from 'postgres';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { startDisposablePostgres } from '../ledger/disposable-postgres.js';
import { createStarterTeam, seedCatalog } from '../teamwork/catalog.js';
import { applyGraphMigration } from '../teamwork/graph-migration.js';
import {
  alice,
  chained,
  drain,
  proposedTask,
  segmentDeps,
} from '../teamwork/graph-test-support.js';
import { createRoutes } from '../teamwork/routes.js';
import { createScriptedModel } from '../teamwork/scripted-model.js';
import { createTask, taskDetail } from '../teamwork/tasks.js';
import { applyWorkbenchMigration } from '../workbench/migration.js';

import type { DisposablePostgres } from '../ledger/disposable-postgres.js';
import type { Deps } from '../teamwork/context.js';
import type { ModelPort } from '../workbench/model-port.js';

let database: DisposablePostgres | undefined;
let sql: postgres.Sql;

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
  await sql`truncate wb_tasks, wb_model_calls, wb_fixture_docs, tw_teammates, tw_conversations, tw_messages, tw_audit, tw_jobs, tw_connections cascade`;
});

function client(deps: Deps) {
  const handle = createRoutes(
    deps,
    (assertion) => Promise.resolve({ sub: alice.sub, email: assertion, assertion } as never),
    () => Promise.resolve({}),
  );
  return (method: 'GET' | 'POST', path: string, payload?: unknown) =>
    handle({
      method,
      path,
      query: new URLSearchParams(),
      headers: { [IAP_ASSERTION_HEADER]: alice.email, 'x-csrf-token': 'test' },
      body: Buffer.from(payload === undefined ? '' : JSON.stringify(payload)),
    });
}

describe('teamwork route table', { timeout: 90_000 }, () => {
  it('serves the graph projection and revises the live graph under compare-and-swap', async () => {
    const deps = segmentDeps(sql);
    const call = client(deps);
    const { taskId, plan } = await proposedTask(deps, 'Compare launches', chained);

    const projection = await call('GET', `/v1/teamwork/tasks/${taskId}/graph`);
    expect(projection.status).toBe(200);
    expect(projection.body).toMatchObject({ projection: { serverRevision: plan.version } });

    const cas = { taskId, baseRevision: plan.version, expectedDigest: plan.digest };
    const revised = await call('POST', `/v1/teamwork/tasks/${taskId}/graph/revise`, {
      cas,
      content: { ...plan.content, summary: 'Revised by the member' },
    });
    expect(revised.status).toBe(200);
    const after = (await taskDetail(deps, alice, taskId))!.plans.at(-1)!;
    expect(after.version).toBe(plan.version + 1);
    expect(after.content.summary).toBe('Revised by the member');

    const stale = await call('POST', `/v1/teamwork/tasks/${taskId}/graph/revise`, {
      cas,
      content: plan.content,
    });
    expect(stale.status).toBe(409);
    expect(stale.body).toMatchObject({ error: 'stale_revision' });
  });

  it('rejects a malformed revision body before any write', async () => {
    const deps = segmentDeps(sql);
    const call = client(deps);
    const { taskId } = await proposedTask(deps, 'Compare launches', chained);
    const before = (await taskDetail(deps, alice, taskId))!.plans.length;
    const reply = await call('POST', `/v1/teamwork/tasks/${taskId}/graph/revise`, {
      cas: { taskId },
    });
    expect(reply.status).toBe(400);
    expect((await taskDetail(deps, alice, taskId))!.plans).toHaveLength(before);
  });
});

function injectingModel(): ModelPort {
  const base = createScriptedModel();
  return {
    ...base,
    generate: async (request) => {
      const reply = await base.generate(request);
      if (!request.system.includes('Propose a plan only')) return reply;
      const parsed = JSON.parse(reply.text.replace(/^```(?:json)?|```$/g, '')) as {
        assignments: object[];
      };
      return {
        ...reply,
        text: JSON.stringify({
          ...parsed,
          assignments: parsed.assignments.map((a) => ({ ...a, approvalOverride: true })),
        }),
      };
    },
  };
}

describe('coordinator plan validation', { timeout: 90_000 }, () => {
  async function run(strict: boolean) {
    const deps = { ...segmentDeps(sql, { model: injectingModel() }), strictProposals: strict };
    await seedCatalog(deps);
    const team = await createStarterTeam(deps, alice);
    const { task } = await createTask(deps, alice, {
      clientRequestId: crypto.randomUUID(),
      workflow: 'research_brief',
      mode: 'coordinated',
      scope: { question: 'Compare launches', metrics: null, repository: null, issueNumber: null },
      resultOwner: team.find((t) => t.name === 'Coordinator')?.id ?? '',
      conversationId: null,
      assignments: [],
    });
    await drain(deps);
    const [row] = await sql<
      { status: string; error_code: string | null; error_message: string | null }[]
    >`select status, error_code, error_message from wb_tasks where id = ${task.id}`;
    return row;
  }

  it('default: the lenient parse still drops unknown keys and reaches plan review', async () => {
    expect((await run(false)).status).toBe('plan_review');
  });

  it('strict: a proposal with an extra approval key is denied whole', async () => {
    const task = await run(true);
    expect(task.status).toBe('failed');
    expect(task.error_code).toBe('invalid_output');
    expect(task.error_message).toContain('refused:');
  });
});
