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
import { createModelGate } from './model.js';
import { createScriptedModel } from './scripted-model.js';
import { createFixtureSources } from './sources/fixture.js';
import { createTask, decidePlan, editPlan, replan, taskDetail } from './tasks.js';
import { createWorker } from './worker.js';

import type { Deps, Member } from './context.js';
import type { DisposablePostgres } from '../ledger/disposable-postgres.js';

/**
 * AGT-00 characterization of the assignment graph as it behaves today, on the scripted model and
 * fixture sources. It pins current behavior for AGT-01 to change on purpose; it is not evidence
 * of production readiness and the runtime it drives is a local fake.
 */
const alice: Member = { sub: 'local-test:alice', email: 'alice@local.test' };
const root = new URL('../../../../', import.meta.url).pathname;

let database: DisposablePostgres | undefined;
let sql: postgres.Sql;

function segment(): Deps {
  const config = readSegmentConfig({
    AW_SEGMENT_ID: 'alpha',
    AW_IDENTITY: 'local-test',
    AW_SOURCE_MODE: 'fixture',
    AW_LOCAL_TEST_MEMBERS: 'alice@local.test',
    AW_KEY_DIR: mkdtempSync(join(tmpdir(), 'tw-keys-')),
  });
  return {
    sql,
    config,
    gate: createModelGate({
      sql,
      segment: 'alpha',
      model: createScriptedModel(),
      limit: 200,
      now: () => new Date(),
      sleep: () => Promise.resolve(),
    }),
    sources: createFixtureSources({ root, segment: 'alpha', sql, faults: true }),
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
  await sql`truncate wb_tasks, wb_model_calls, wb_fixture_docs, tw_teammates, tw_conversations, tw_messages, tw_audit, tw_jobs, tw_connections cascade`;
});

/** A coordinated task whose plan is approved, optionally with the second step waiting on the first. */
async function approvedTask(d: Deps, question: string, chain: boolean) {
  await seedCatalog(d);
  const teammates = await createStarterTeam(d, alice);
  const coordinator = teammates.find((t) => t.name === 'Coordinator')?.id ?? '';
  const worker = createWorker(d, (error) => {
    throw error;
  });
  const { task } = await createTask(d, alice, {
    clientRequestId: crypto.randomUUID(),
    workflow: 'research_brief',
    mode: 'coordinated',
    scope: { question, metrics: null, repository: null, issueNumber: null },
    resultOwner: coordinator,
    conversationId: null,
    assignments: [],
  });
  await worker.drain();
  const proposed = (await taskDetail(d, alice, task.id))!.plans[0];
  let version = proposed.version;
  let digest = proposed.digest;
  if (chain) {
    const [first, second] = proposed.content.assignments;
    await editPlan(d, alice, task.id, {
      baseVersion: version,
      content: {
        ...proposed.content,
        assignments: [first, { ...second, dependsOn: [first.key] }],
      },
    });
    const edited = (await taskDetail(d, alice, task.id))!.plans.find((p) => p.version === 2)!;
    version = edited.version;
    digest = edited.digest;
  }
  await decidePlan(d, alice, task.id, { version, expectedDigest: digest, decision: 'approve' });
  return { taskId: task.id, version };
}

describe('assignment graph today', { timeout: 30_000 }, () => {
  // DEFECT PIN for AGT-01. `releaseDependents` tries `queued -> failed` with dependency_failed, but
  // ASSIGNMENT_TRANSITIONS forbids that edge, so `moveAssignment` returns undefined. The dependent
  // is never failed or blocked visibly and the task stays `running` with nothing left to run.
  it('leaves the dependent of a failed prerequisite queued and the task running', async () => {
    const d = segment();
    const { taskId } = await approvedTask(d, 'Compare [fault:denied]', true);
    await createWorker(d, (error) => {
      throw error;
    }).drain();
    const detail = (await taskDetail(d, alice, taskId))!;
    const [first, second] = detail.assignments;
    expect([first.status, first.errorCode]).toEqual(['failed', 'source_denied']);
    expect([second.status, second.errorCode]).toEqual(['queued', null]);
    expect(second.startedAt).toBeNull();
    expect(detail.task.status).toBe('running');
    const open =
      await sql`select 1 from tw_jobs where task_id = ${taskId} and kind = 'assignment' and state in ('queued', 'running')`;
    expect(open).toHaveLength(0);
    const calls = await sql`select 1 from wb_model_calls where purpose = 'contribution'`;
    expect(calls).toHaveLength(0);
  });

  it('offers no replan from that stuck state, only the plan_review and needs_input states', async () => {
    const d = segment();
    const { taskId } = await approvedTask(d, 'Compare [fault:denied]', true);
    await createWorker(d, (error) => {
      throw error;
    }).drain();
    await expect(replan(d, alice, taskId, 'Try again')).rejects.toThrow('cannot_replan');
  });

  it('runs each assignment exactly once when two workers drain the same queue at once', async () => {
    const d = segment();
    const { taskId } = await approvedTask(d, 'Which feature-flag service should we adopt?', false);
    const onError = (error: unknown) => {
      throw error;
    };
    await Promise.all([createWorker(d, onError).drain(), createWorker(d, onError).drain()]);
    const detail = (await taskDetail(d, alice, taskId))!;
    expect(detail.assignments.map((a) => [a.status, a.attempt])).toEqual([
      ['succeeded', 1],
      ['succeeded', 1],
    ]);
    const calls = await sql`select 1 from wb_model_calls where purpose = 'contribution'`;
    expect(calls).toHaveLength(2);
    const done = await sql`select 1 from tw_jobs where kind = 'assignment' and state = 'done'`;
    expect(done).toHaveLength(2);
  });

  it('has revisioned plans but no graph revision, retry schedule or per-node approval column', async () => {
    const columns = async (table: string) =>
      (
        await sql<
          { column_name: string }[]
        >`select column_name from information_schema.columns where table_name = ${table}`
      ).map((row) => row.column_name);
    const assignments = await columns('tw_assignments');
    expect(assignments).toContain('depends_on');
    expect(assignments).toContain('plan_version');
    expect(assignments).toContain('attempt');
    for (const absent of ['revision', 'graph_revision', 'retry_at', 'not_before', 'approval_id'])
      expect(assignments).not.toContain(absent);
    const plans = await sql<
      { indexdef: string }[]
    >`select indexdef from pg_indexes where tablename = 'tw_plans'`;
    expect(plans.map((p) => p.indexdef).join('\n')).toContain(
      "WHERE (state = ANY (ARRAY['proposed'",
    );
  });
});
