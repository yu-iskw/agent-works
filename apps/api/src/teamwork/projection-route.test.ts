import postgres from 'postgres';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { startDisposablePostgres } from '../ledger/disposable-postgres.js';
import { applyWorkbenchMigration } from '../workbench/migration.js';

import { Conflict } from './context.js';
import { applyGraphMigration } from './graph-migration.js';
import { alice, approve, chained, drain, proposedTask, segmentDeps } from './graph-test-support.js';
import { buildProjection, mutateGraph, projectionRoutes } from './projection-route.js';
import { editPlan, taskDetail } from './tasks.js';

import type { Deps, Member } from './context.js';
import type { DisposablePostgres } from '../ledger/disposable-postgres.js';

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

const CANARY = 'CANARY-PRIVATE-9f3a';
const eve: Member = { sub: 'local-test:eve', email: 'eve@local.test' };

const view = async (d: Deps, taskId: string) => {
  const built = await buildProjection(d, alice, taskId);
  if (built?.projection === null || built === undefined) throw new Error('no projection');
  return built.projection;
};

const cas = (taskId: string, plan: { version: number; digest: string }) => ({
  taskId,
  baseRevision: plan.version,
  expectedDigest: plan.digest,
});
const mutation = (taskId: string, plan: { version: number; digest: string }) => ({
  clientRequestId: crypto.randomUUID(),
  cas: cas(taskId, plan),
  taskVersion: 1,
});

const assignmentCount = async (taskId: string) =>
  Number((await sql`select count(*)::int as n from tw_assignments where task_id = ${taskId}`)[0].n);

describe('graph projection', { timeout: 90_000 }, () => {
  it('shows a proposed revision as blocked on plan approval, then the running graph', async () => {
    const d = segmentDeps(sql);
    const { taskId, plan } = await proposedTask(d, 'Compare launches', chained);

    const proposed = await view(d, taskId);
    expect(proposed.serverRevision).toBe(plan.version);
    expect(proposed.digest).toBe(plan.digest);
    expect(proposed.nodes.map((n) => [n.state, n.reason])).toEqual([
      ['blocked', 'plan_not_approved'],
      ['blocked', 'plan_not_approved'],
    ]);

    await approve(d, taskId, plan);
    const queued = await view(d, taskId);
    expect(queued.nodes.map((n) => n.state)).toEqual(['ready', 'blocked']);
    expect(queued.nodes[1].reason).toBe('prerequisite_pending');
    expect(queued.nodes[1].dependsOn).toEqual([queued.nodes[0].key]);

    await drain(d);
    const finished = await view(d, taskId);
    expect(finished.nodes.every((n) => n.state === 'succeeded')).toBe(true);
    expect(finished.taskVersion).toBeGreaterThan(queued.taskVersion);
  });

  it('reports retry time, approval needs and result links from stored facts only', async () => {
    const d = segmentDeps(sql);
    const { taskId, plan } = await proposedTask(d, 'Compare launches');
    await approve(d, taskId, plan);
    await drain(d);
    const [first, second] = (await sql<{ id: string }[]>`
      select id from tw_assignments where task_id = ${taskId} order by created_at, key`) as {
      id: string;
    }[];
    const later = new Date(Date.now() + 60_000);
    await sql`update tw_assignments set status = 'queued', finished_at = null, retry_not_before = ${later} where id = ${first.id}`;
    await sql`update tw_assignments set status = 'needs_input', question = ${CANARY}, finished_at = null where id = ${second.id}`;

    const nodes = (await view(d, taskId)).nodes;
    const retry = nodes.find((n) => n.state === 'retry_wait');
    expect(retry?.reason).toBe('retry_backoff');
    expect(retry?.retryAt).toBe(later.toISOString());
    const waiting = nodes.find((n) => n.state === 'awaiting_approval');
    expect(waiting?.approval?.kind).toBe('input');
    expect(JSON.stringify(nodes)).not.toContain(CANARY);
  });

  it('links a result to a path the web router recognizes as that result panel', async () => {
    const d = segmentDeps(sql);
    const { taskId, plan } = await proposedTask(d, 'Compare launches');
    await approve(d, taskId, plan);
    await drain(d);
    // The web router lives outside this package's rootDir; the test loads it, the build does not.
    const routerPath = new URL('../../../web/shared/route.ts', import.meta.url).href;
    const { parseRoute } = (await import(/* @vite-ignore */ routerPath)) as {
      parseRoute: (pathname: string) => unknown;
    };
    const links = (await view(d, taskId)).nodes.flatMap((n) => (n.result ? [n.result.href] : []));
    expect(links.length).toBeGreaterThan(0);
    const [{ result_owner: owner, latest_revision: revision }] = await sql<
      { result_owner: string; latest_revision: number }[]
    >`select result_owner, latest_revision from wb_tasks where id = ${taskId}`;
    for (const href of links) {
      expect(parseRoute(href)).toMatchObject({
        segment: d.config.segment,
        teammate: owner,
        panel: { kind: 'result', taskId, revision, view: 'result' },
      });
    }
  });

  it('omits an inaccessible node and every trace of it, in the body as well as the nodes', async () => {
    const d = segmentDeps(sql);
    const { taskId, plan } = await proposedTask(d, 'Compare launches', chained);
    await approve(d, taskId, plan);
    await drain(d);
    const rows = await sql<{ id: string; key: string; teammate_id: string }[]>`
      select id, key, teammate_id from tw_assignments where task_id = ${taskId} order by created_at, key`;
    const [open, hidden] = rows;
    const foreign = crypto.randomUUID();
    await sql`
      insert into tw_teammates (id, owner_sub, client_request_id, origin, template_id, template_version,
        name, role, instructions, capability_requests, version, conversation_id, archived, created_at, updated_at)
      select ${foreign}, ${eve.sub}, gen_random_uuid(), origin, template_id, template_version,
        ${CANARY + '-name'}, role, instructions, capability_requests, version, gen_random_uuid(), false, created_at, updated_at
      from tw_teammates where id = ${hidden.teammate_id}`;
    await sql`update tw_assignments set teammate_id = ${foreign}, deliverable = ${CANARY + '-deliverable'},
      brief = ${CANARY + '-brief'}, error_message = ${CANARY + '-error'} where id = ${hidden.id}`;
    await sql`update tw_assignments set brief = ${CANARY + '-brief-visible'},
      error_message = ${CANARY + '-error-visible'} where id = ${open.id}`;

    const built = await buildProjection(d, alice, taskId);
    const body = JSON.stringify(built);
    expect(body).not.toContain('CANARY');
    expect(body).not.toContain(hidden.key);
    expect(built?.projection?.nodes.map((n) => n.key)).toEqual([open.key]);
    expect(Object.keys(built ?? {}).sort()).toEqual(['projection', 'taskVersion']);

    const reply = await projectionRoutes()[0].handle(
      { deps: d, member: alice, request: undefined as never },
      [taskId],
    );
    expect(JSON.stringify(reply.body)).not.toContain('CANARY');
    expect((reply.body as { segment: string }).segment).toBe('alpha');
  });

  it("does not show another member's task", async () => {
    const d = segmentDeps(sql);
    const { taskId } = await proposedTask(d, 'Compare launches');
    expect(await buildProjection(d, eve, taskId)).toBeUndefined();
    const reply = await projectionRoutes()[0].handle(
      { deps: d, member: eve, request: undefined as never },
      [taskId],
    );
    expect(reply.status).toBe(404);
  });
});

describe('graph mutations are compare-and-swap', { timeout: 90_000 }, () => {
  it('refuses an approval based on an old revision and writes nothing', async () => {
    const d = segmentDeps(sql);
    const { taskId, plan } = await proposedTask(d, 'Compare launches');
    await editPlan(d, alice, taskId, {
      baseVersion: plan.version,
      content: { ...plan.content, summary: 'Edited by the member' },
    });
    const live = (await taskDetail(d, alice, taskId))!.plans.at(-1)!;
    expect(live.version).toBe(plan.version + 1);

    await expect(mutateGraph(d, alice, taskId, 'approve', mutation(taskId, plan))).rejects.toThrow(
      'stale_revision',
    );
    expect(await assignmentCount(taskId)).toBe(0);
    expect((await taskDetail(d, alice, taskId))!.task.status).toBe('plan_review');

    await mutateGraph(d, alice, taskId, 'approve', mutation(taskId, live));
    expect(await assignmentCount(taskId)).toBeGreaterThan(0);
  });

  it('lets exactly one of several identical approvals dispatch the plan once', async () => {
    const d = segmentDeps(sql);
    const { taskId, plan } = await proposedTask(d, 'Compare launches');
    const settled = await Promise.allSettled(
      Array.from({ length: 6 }, () =>
        mutateGraph(d, alice, taskId, 'approve', mutation(taskId, plan)),
      ),
    );
    expect(settled.filter((s) => s.status === 'fulfilled')).toHaveLength(1);
    for (const s of settled) if (s.status === 'rejected') expect(s.reason).toBeInstanceOf(Conflict);
    expect(await assignmentCount(taskId)).toBe(plan.content.assignments.length);
  });

  it('refuses a cancel against a digest it never saw and cancels once for the current one', async () => {
    const d = segmentDeps(sql);
    const { taskId, plan } = await proposedTask(d, 'Compare launches');
    await approve(d, taskId, plan);
    await expect(
      mutateGraph(d, alice, taskId, 'cancel', {
        ...mutation(taskId, plan),
        cas: { ...cas(taskId, plan), expectedDigest: 'f'.repeat(64) },
      }),
    ).rejects.toThrow('digest_mismatch');
    await expect(
      mutateGraph(d, alice, taskId, 'cancel', {
        ...mutation(taskId, plan),
        cas: { ...cas(taskId, plan), baseRevision: plan.version + 3 },
      }),
    ).rejects.toThrow('stale_revision');
    expect((await taskDetail(d, alice, taskId))!.task.status).toBe('running');

    const settled = await Promise.allSettled(
      Array.from({ length: 4 }, () =>
        mutateGraph(d, alice, taskId, 'cancel', mutation(taskId, plan)),
      ),
    );
    expect(settled.filter((s) => s.status === 'fulfilled')).toHaveLength(1);
    expect((await taskDetail(d, alice, taskId))!.task.status).toBe('cancelled');
    const cancelEvents =
      await sql`select 1 from wb_events where task_id = ${taskId} and type = 'task.cancelled'`;
    expect(cancelEvents).toHaveLength(1);
  });

  it("cannot be applied to another member's task, and a bad body is a 400", async () => {
    const d = segmentDeps(sql);
    const { taskId, plan } = await proposedTask(d, 'Compare launches');
    await expect(
      mutateGraph(d, eve, taskId, 'approve', mutation(taskId, plan)),
    ).rejects.toMatchObject({ status: 404 });
    const route = projectionRoutes().find((r) => r.method === 'POST')!;
    await expect(
      route.handle({ deps: d, member: alice, request: { body: Buffer.from('{}') } as never }, [
        taskId,
      ]),
    ).rejects.toMatchObject({ status: 400 });
  });
});
