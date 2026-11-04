import { logicalNodeState } from '@agent-works/domain/teamwork-graph-contract';
import postgres from 'postgres';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { startDisposablePostgres } from '../ledger/disposable-postgres.js';
import { applyWorkbenchMigration } from '../workbench/migration.js';

import { applyGraphMigration } from './graph-migration.js';
import { reviseGraph } from './graph-revision.js';
import {
  alice,
  approve,
  chained,
  drain,
  failingModel,
  proposedTask,
  segmentDeps,
} from './graph-test-support.js';
import {
  PROPAGATION_POLICY,
  RETRY_POLICY,
  assertGraphCas,
  blockedDependents,
  createNodeClaims,
  retryNotBefore,
} from './graph.js';
import { moveAssignment, rerunAsNewNode } from './store.js';
import { cancelTask, decideMissing, replan, taskDetail } from './tasks.js';
import { recoverGraphs } from './worker.js';

import type { Deps } from './context.js';
import type { AssignmentRow } from './store.js';
import type { DisposablePostgres } from '../ledger/disposable-postgres.js';
import type { GraphRevision } from '@agent-works/domain/teamwork-graph-contract';

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

const nodes = (taskId: string) =>
  sql<
    AssignmentRow[]
  >`select * from tw_assignments where task_id = ${taskId} order by key, created_at`;

const modelCalls = async (assignmentId: string) =>
  Number(
    (
      await sql`select count(*)::int as n from wb_model_calls where assignment_id = ${assignmentId}`
    ).at(0)?.n,
  );

async function graphSnapshot(taskId: string) {
  return JSON.stringify({
    plans:
      await sql`select version, state, digest, content from tw_plans where task_id = ${taskId} order by version`,
    nodes:
      await sql`select id, key, status, attempt, brief, output, finished_at, plan_version, owner_token from tw_assignments where task_id = ${taskId} order by key, created_at`,
    jobs: await sql`select kind, ref, state from tw_jobs where task_id = ${taskId} order by id`,
    task: await sql`select status, version from wb_tasks where id = ${taskId}`,
  });
}

/** Node A succeeded, node B failed for a reason retrying cannot fix. The task waits for the member. */
async function halfDone(d: Deps) {
  const { taskId, plan } = await proposedTask(
    d,
    'Which feature-flag service should we adopt?',
    (c) => ({
      ...c,
      assignments: [
        c.assignments[0],
        { ...c.assignments[1], brief: `${c.assignments[1].brief} FAILME` },
      ],
    }),
  );
  await approve(d, taskId, plan);
  await drain(d);
  const [a, b] = await nodes(taskId);
  return {
    taskId,
    plan,
    a,
    b,
    cas: { taskId, baseRevision: plan.version, expectedDigest: plan.digest },
  };
}

const failing = () => failingModel('FAILME', 'permission_denied');

describe('policy and pure rules', { timeout: 90_000 }, () => {
  it('commits the propagation and retry policy as data', () => {
    expect(PROPAGATION_POLICY).toEqual({
      failure: 'block_unfinished_dependents',
      cancel: 'cancel_unstarted_finish_step',
      rerun: 'new_node_supersede_old',
    });
    expect(RETRY_POLICY.maxAutomaticAttempts).toBe(3);
    const base = new Date('2026-11-03T00:00:00.000Z');
    expect(retryNotBefore(base, 1).toISOString()).toBe('2026-11-03T00:00:30.000Z');
    expect(retryNotBefore(base, 2).toISOString()).toBe('2026-11-03T00:01:00.000Z');
  });

  it('blocks dependents transitively and leaves independent and finished nodes alone', () => {
    const node = (key: string, status: string, depends_on: string[] = []) =>
      ({ key, status, depends_on, id: key }) as unknown as AssignmentRow;
    const live = [
      node('a', 'failed'),
      node('b', 'queued', ['a']),
      node('c', 'queued', ['b']),
      node('d', 'queued'),
      node('e', 'queued', ['d']),
      node('f', 'succeeded', ['a']),
    ];
    expect(blockedDependents(live).map((n) => n.key)).toEqual(['b', 'c']);
  });

  it('maps every CAS outcome to a refusal and applies only a matching live revision', () => {
    const taskId = crypto.randomUUID();
    const digest = 'a'.repeat(64);
    const revision = (state: GraphRevision['state']): GraphRevision => ({
      taskId,
      revision: 2,
      digest,
      parentRevision: 1,
      state,
    });
    const cas = { taskId, baseRevision: 2, expectedDigest: digest };
    expect(() => assertGraphCas(revision('approved'), cas)).not.toThrow();
    expect(() => assertGraphCas(revision('approved'), { ...cas, baseRevision: 1 })).toThrow(
      'stale_revision',
    );
    expect(() =>
      assertGraphCas(revision('approved'), { ...cas, expectedDigest: 'b'.repeat(64) }),
    ).toThrow('digest_mismatch');
    expect(() => assertGraphCas(revision('superseded'), cas)).toThrow('not_live');
    expect(() => assertGraphCas(undefined, cas)).toThrow('not_live');
  });
});

describe('dependency transitions and failure propagation', { timeout: 90_000 }, () => {
  it('blocks a dependent of a failed prerequisite, reaches needs_input, and retries both together', async () => {
    const d = segmentDeps(sql);
    const { taskId, plan } = await proposedTask(d, 'Compare [fault:denied]', chained);
    await approve(d, taskId, plan);
    await drain(d);
    const [first, second] = await nodes(taskId);
    expect([first.status, second.status, second.error_code]).toEqual([
      'failed',
      'failed',
      'dependency_failed',
    ]);
    const facts = {
      status: second.status,
      errorCode: second.error_code,
      dependenciesSatisfied: false,
      retryNotBefore: null,
      effectUnconfirmed: false,
      now: new Date().toISOString(),
    };
    expect(logicalNodeState(facts)).toBe('blocked');
    expect((await taskDetail(d, alice, taskId))!.task.status).toBe('needs_input');

    await decideMissing(d, alice, taskId, { decision: 'retry', assignmentIds: [first.id] });
    const after = await nodes(taskId);
    expect(after.map((n) => [n.status, n.attempt, n.error_code])).toEqual([
      ['queued', 2, null],
      ['queued', 2, null],
    ]);
    const jobs = await sql<
      { ref: string }[]
    >`select ref from tw_jobs where task_id = ${taskId} and state = 'queued' and kind = 'assignment'`;
    expect(jobs.map((j) => j.ref)).toEqual([`${first.id}:2`]);
  });

  it('runs a dependent only after its prerequisite succeeded and refuses to claim it earlier', async () => {
    const d = segmentDeps(sql);
    const { taskId, plan } = await proposedTask(
      d,
      'Which feature-flag service should we adopt?',
      chained,
    );
    await approve(d, taskId, plan);
    const [first, second] = await nodes(taskId);
    const claims = createNodeClaims(sql, d);
    expect(await claims.claim(second.id, new Date())).toBeUndefined();
    await drain(d);
    const done = await nodes(taskId);
    expect(done.map((n) => n.status)).toEqual(['succeeded', 'succeeded']);
    expect(done[1].started_at!.getTime()).toBeGreaterThanOrEqual(done[0].finished_at!.getTime());
    expect(first.id).toBe(done[0].id);
  });

  it('settles a task left running with no job after a restart', async () => {
    const d = segmentDeps(sql);
    const { taskId, plan } = await proposedTask(d, 'Which feature-flag service should we adopt?');
    await approve(d, taskId, plan);
    await sql`update tw_jobs set state = 'cancelled' where task_id = ${taskId} and kind = 'assignment'`;
    expect((await taskDetail(d, alice, taskId))!.task.status).toBe('running');
    expect(await recoverGraphs(d)).toBe(1);
    expect(await recoverGraphs(d)).toBe(0);
    await drain(d);
    expect((await nodes(taskId)).map((n) => n.status)).toEqual(['succeeded', 'succeeded']);
  });
});

describe('single owner', { timeout: 90_000 }, () => {
  it('lets exactly one of twelve racers claim a node, in every round', async () => {
    const d = segmentDeps(sql);
    const { taskId, plan } = await proposedTask(d, 'Which feature-flag service should we adopt?');
    await approve(d, taskId, plan);
    const claims = createNodeClaims(sql, d);
    const [target] = await nodes(taskId);
    for (let round = 0; round < 8; round += 1) {
      const racers = Array.from({ length: 12 }, () => claims.claim(target.id, new Date()));
      const winners = (await Promise.all(racers)).filter((row) => row !== undefined);
      expect(winners).toHaveLength(1);
      expect(winners[0]?.owner_token).not.toBeNull();
      await sql`update tw_assignments set status = 'queued', owner_token = null where id = ${target.id}`;
    }
  });

  it('runs each node once when eight workers drain together', async () => {
    const d = segmentDeps(sql);
    const { taskId, plan } = await proposedTask(d, 'Which feature-flag service should we adopt?');
    await approve(d, taskId, plan);
    await Promise.all(Array.from({ length: 8 }, () => drain(d)));
    const done = await nodes(taskId);
    expect(done.map((n) => [n.status, n.attempt])).toEqual([
      ['succeeded', 1],
      ['succeeded', 1],
    ]);
    for (const node of done) expect(await modelCalls(node.id)).toBe(1);
  });

  it('fences out a dead owner once another worker took the node over', async () => {
    const d = segmentDeps(sql);
    const { taskId, plan } = await proposedTask(d, 'Which feature-flag service should we adopt?');
    await approve(d, taskId, plan);
    const claims = createNodeClaims(sql, d);
    const [target] = await nodes(taskId);
    const zombie = (await claims.claim(target.id, new Date()))!;
    const successor = (await claims.takeOver(target.id))!;
    expect(successor.owner_token).not.toBe(zombie.owner_token);
    await sql.begin(async (tx) => {
      const late = await moveAssignment(d, tx, zombie, 'succeeded', {
        fence: zombie.owner_token!,
      });
      expect(late).toBeUndefined();
      const live = await moveAssignment(d, tx, successor, 'succeeded', {
        fence: successor.owner_token!,
      });
      expect(live?.status).toBe('succeeded');
      expect(live?.owner_token).toBeNull();
    });
  });

  it('resumes a node whose worker died, once, and finishes it', async () => {
    const d = segmentDeps(sql);
    const { taskId, plan } = await proposedTask(d, 'Which feature-flag service should we adopt?');
    await approve(d, taskId, plan);
    const claims = createNodeClaims(sql, d);
    const [target] = await nodes(taskId);
    const dead = (await claims.claim(target.id, new Date()))!;
    await sql`update tw_jobs set state = 'running', attempts = 1, lease_until = now() - interval '1 minute' where kind = 'assignment' and ref like ${`${target.id}:%`}`;
    await drain(d);
    const [after] = await nodes(taskId);
    expect(after.status).toBe('succeeded');
    expect(after.owner_token).toBeNull();
    expect(dead.owner_token).not.toBeNull();
    expect(await modelCalls(target.id)).toBe(1);
  });
});

describe('retry_wait', { timeout: 90_000 }, () => {
  it('stores a not-before time, holds the job until then, and ends in failure after the last attempt', async () => {
    let offset = 0;
    const now = () => new Date(Date.now() + offset);
    const d = segmentDeps(sql, { model: failingModel('RATELIMIT', 'rate_limited'), now });
    const { taskId, plan } = await proposedTask(
      d,
      'Which feature-flag service should we adopt?',
      (c) => ({
        ...c,
        assignments: [{ ...c.assignments[0], brief: `${c.assignments[0].brief} RATELIMIT` }],
      }),
    );
    await sql`update tw_jobs set state='done'`;
    await approve(d, taskId, plan);
    await drain(d);
    let [node] = await nodes(taskId);
    expect([node.status, node.attempt, node.error_code]).toEqual(['queued', 2, 'rate_limited']);
    const waitUntil = node.retry_not_before!;
    expect(waitUntil.getTime()).toBeGreaterThan(Date.now() + 25_000);
    expect(
      logicalNodeState({
        status: node.status,
        errorCode: node.error_code,
        dependenciesSatisfied: true,
        retryNotBefore: waitUntil.toISOString(),
        effectUnconfirmed: false,
        now: now().toISOString(),
      }),
    ).toBe('retry_wait');
    const [job] = await sql<
      { run_after: Date }[]
    >`select run_after from tw_jobs where ref = ${`${node.id}:2`}`;
    expect(job.run_after.getTime()).toBe(waitUntil.getTime());
    expect((await taskDetail(d, alice, taskId))!.task.status).toBe('running');

    await drain(d);
    expect((await nodes(taskId))[0].attempt).toBe(2);

    offset = 60_000;
    await drain(d);
    [node] = await nodes(taskId);
    expect([node.status, node.attempt]).toEqual(['queued', 3]);
    offset = 600_000;
    await drain(d);
    [node] = await nodes(taskId);
    expect([node.status, node.attempt, node.error_code]).toEqual(['failed', 3, 'rate_limited']);
    expect((await taskDetail(d, alice, taskId))!.task.status).toBe('needs_input');
  }, 60_000);

  it('cancels a node that is waiting to retry', async () => {
    const d = segmentDeps(sql, { model: failingModel('RATELIMIT', 'rate_limited') });
    const { taskId, plan } = await proposedTask(
      d,
      'Which feature-flag service should we adopt?',
      (c) => ({
        ...c,
        assignments: [{ ...c.assignments[0], brief: `${c.assignments[0].brief} RATELIMIT` }],
      }),
    );
    await approve(d, taskId, plan);
    await drain(d);
    expect((await nodes(taskId))[0].status).toBe('queued');
    await cancelTask(d, alice, taskId);
    const [node] = await nodes(taskId);
    expect(node.status).toBe('cancelled');
    expect((await taskDetail(d, alice, taskId))!.task.status).toBe('cancelled');
    const open =
      await sql`select 1 from tw_jobs where task_id = ${taskId} and state in ('queued', 'running')`;
    expect(open).toHaveLength(0);
  }, 60_000);
});

describe('cancellation propagation', { timeout: 90_000 }, () => {
  it('cancels every unstarted node of a chain and its jobs, and publishes nothing', async () => {
    const d = segmentDeps(sql);
    const { taskId, plan } = await proposedTask(
      d,
      'Which feature-flag service should we adopt?',
      chained,
    );
    await approve(d, taskId, plan);
    await cancelTask(d, alice, taskId);
    expect((await nodes(taskId)).map((n) => n.status)).toEqual(['cancelled', 'cancelled']);
    expect((await taskDetail(d, alice, taskId))!.task.status).toBe('cancelled');
    const open =
      await sql`select 1 from tw_jobs where task_id = ${taskId} and state in ('queued', 'running')`;
    expect(open).toHaveLength(0);
  });
});

describe(
  'revisions are compare-and-swap and never replay completed effects',
  { timeout: 90_000 },
  () => {
    it('rejects a stale revision, a changed digest, a cycle and a dangling edge, writing nothing', async () => {
      const d = segmentDeps(sql, { model: failing() });
      const { taskId, plan, cas } = await halfDone(d);
      const before = await graphSnapshot(taskId);
      const [a, b] = plan.content.assignments;
      const edit = { ...plan.content, assignments: [a, { ...b, brief: 'Try a narrower scope' }] };
      const attempt = (change: object, content = edit) =>
        reviseGraph(d, alice, taskId, { cas: { ...cas, ...change }, content });

      await expect(attempt({ baseRevision: cas.baseRevision - 1 })).rejects.toThrow(
        'stale_revision',
      );
      await expect(attempt({ expectedDigest: 'f'.repeat(64) })).rejects.toThrow('digest_mismatch');
      const cyclic = {
        ...edit,
        assignments: [
          { ...a, dependsOn: [b.key] },
          { ...edit.assignments[1], dependsOn: [a.key] },
        ],
      };
      await expect(attempt({}, cyclic)).rejects.toThrow('bad_dependency');
      const dangling = {
        ...edit,
        assignments: [a, { ...edit.assignments[1], dependsOn: ['ghost'] }],
      };
      await expect(attempt({}, dangling)).rejects.toThrow('bad_dependency');
      expect(await graphSnapshot(taskId)).toBe(before);
    });

    it('refuses an edit that drops or redefines a completed node', async () => {
      const d = segmentDeps(sql, { model: failing() });
      const { taskId, plan, a, cas } = await halfDone(d);
      const [first, second] = plan.content.assignments;
      expect(a.status).toBe('succeeded');
      const before = await graphSnapshot(taskId);
      await expect(
        reviseGraph(d, alice, taskId, {
          cas,
          content: {
            ...plan.content,
            assignments: [{ ...first, brief: 'Do something else' }, second],
          },
        }),
      ).rejects.toThrow('completed_node_changed');
      await expect(
        reviseGraph(d, alice, taskId, { cas, content: { ...plan.content, assignments: [second] } }),
      ).rejects.toThrow('completed_node_changed');
      expect(await graphSnapshot(taskId)).toBe(before);
    });

    it('keeps the completed node untouched and runs only the new one after the edit is approved', async () => {
      const d = segmentDeps(sql, { model: failing() });
      const { taskId, plan, a, b, cas } = await halfDone(d);
      const [first, second] = plan.content.assignments;
      await reviseGraph(d, alice, taskId, {
        cas,
        content: {
          ...plan.content,
          assignments: [first, { ...second, brief: 'Try a narrower scope' }],
        },
      });
      let detail = (await taskDetail(d, alice, taskId))!;
      expect(detail.task.status).toBe('plan_review');
      const next = detail.plans.at(-1)!;
      expect([next.version, next.state]).toEqual([plan.version + 1, 'proposed']);
      expect((await nodes(taskId)).map((n) => [n.key, n.status])).toEqual([
        [first.key, 'succeeded'],
        [second.key, 'superseded'],
      ]);

      await approve(d, taskId, next);
      await drain(d);
      const all = await nodes(taskId);
      const live = all.filter((n) => n.status !== 'superseded');
      expect(live.map((n) => [n.key, n.status])).toEqual([
        [first.key, 'succeeded'],
        [second.key, 'succeeded'],
      ]);
      const [aAfter] = all.filter((n) => n.id === a.id);
      expect(aAfter.attempt).toBe(1);
      expect(aAfter.finished_at?.getTime()).toBe(a.finished_at?.getTime());
      expect(aAfter.output).toEqual(a.output);
      expect(await modelCalls(a.id)).toBe(1);
      expect(all.some((n) => n.id === b.id && n.status === 'superseded')).toBe(true);
      detail = (await taskDetail(d, alice, taskId))!;
      expect(detail.task.status).toBe('ready');
    });

    it('keeps completed nodes as they were when the coordinator replans', async () => {
      const d = segmentDeps(sql, { model: failing() });
      const { taskId, a } = await halfDone(d);
      await replan(d, alice, taskId, 'Start over');
      await drain(d);
      const detail = (await taskDetail(d, alice, taskId))!;
      expect(detail.task.status).toBe('plan_review');
      const proposed = detail.plans.at(-1)!;
      const pinned = proposed.content.assignments.find((n) => n.key === a.key)!;
      expect([pinned.brief, pinned.teammateId]).toEqual([a.brief, a.teammate_id]);
      await approve(d, taskId, proposed);
      await drain(d);
      const [aAfter] = (await nodes(taskId)).filter((n) => n.id === a.id);
      expect([aAfter.status, aAfter.attempt]).toEqual(['succeeded', 1]);
      expect(await modelCalls(a.id)).toBe(1);
    });

    it('starts synthesis when the approved revision leaves nothing to dispatch', async () => {
      const d = segmentDeps(sql, { model: failing() });
      const { taskId, plan, a, cas } = await halfDone(d);
      await reviseGraph(d, alice, taskId, {
        cas,
        content: { ...plan.content, assignments: [plan.content.assignments[0]] },
      });
      const next = (await taskDetail(d, alice, taskId))!.plans.at(-1)!;
      await approve(d, taskId, next);
      const queued = await sql<
        { kind: string }[]
      >`select kind from tw_jobs where task_id = ${taskId} and state = 'queued'`;
      expect(queued.map((j) => j.kind)).toEqual(['synthesis']);
      expect((await taskDetail(d, alice, taskId))!.task.status).toBe('synthesizing');
      await drain(d);
      expect((await taskDetail(d, alice, taskId))!.task.status).toBe('ready');
      expect(await modelCalls(a.id)).toBe(1);
    });

    it('leaves the last committed graph when the editor dies inside the transaction', async () => {
      const d = segmentDeps(sql, { model: failing() });
      const { taskId, plan, cas } = await halfDone(d);
      const [first, second] = plan.content.assignments;
      const before = await graphSnapshot(taskId);
      let calls = 0;
      const dying: Deps = {
        ...d,
        now: () => {
          calls += 1;
          if (calls === 3) throw new Error('coordinator crashed');
          return new Date();
        },
      };
      await expect(
        reviseGraph(dying, alice, taskId, {
          cas,
          content: { ...plan.content, assignments: [first, { ...second, brief: 'Try again' }] },
        }),
      ).rejects.toThrow('coordinator crashed');
      expect(calls).toBeGreaterThanOrEqual(3);
      expect(await graphSnapshot(taskId)).toBe(before);
      await reviseGraph(d, alice, taskId, {
        cas,
        content: { ...plan.content, assignments: [first, { ...second, brief: 'Try again' }] },
      });
      expect((await taskDetail(d, alice, taskId))!.task.status).toBe('plan_review');
    });
  },
);

describe('a rerun is a new node', { timeout: 90_000 }, () => {
  it('supersedes the finished node with its effect intact and queues a fresh one', async () => {
    const d = segmentDeps(sql);
    const { taskId, plan } = await proposedTask(d, 'Which feature-flag service should we adopt?');
    await approve(d, taskId, plan);
    await drain(d);
    const [done] = await nodes(taskId);
    expect(done.status).toBe('succeeded');
    const fresh = await sql.begin((tx) => rerunAsNewNode(d, tx, done));
    expect(fresh).toMatchObject({ key: done.key, status: 'queued', attempt: 2, output: null });
    expect(fresh?.id).not.toBe(done.id);
    const [old] = await sql<AssignmentRow[]>`select * from tw_assignments where id = ${done.id}`;
    expect(old.status).toBe('superseded');
    expect(old.output).toEqual(done.output);
    expect(old.finished_at?.getTime()).toBe(done.finished_at?.getTime());
    await expect(
      sql`update tw_assignments set status = 'queued' where id = ${done.id}`,
    ).rejects.toThrow(/tw_assignments_live_key/);
  });
});
