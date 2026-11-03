import postgres from 'postgres';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { startDisposablePostgres } from '../ledger/disposable-postgres.js';
import { applyWorkbenchMigration } from '../workbench/migration.js';

import { applyGraphMigration } from './graph-migration.js';
import { alice, approve, chained, drain, proposedTask, segmentDeps } from './graph-test-support.js';
import { createScriptedModel } from './scripted-model.js';
import { taskDetail } from './tasks.js';

import type { AssignmentRow } from './store.js';
import type { DisposablePostgres } from '../ledger/disposable-postgres.js';
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

const nodes = (taskId: string) =>
  sql<AssignmentRow[]>`select * from tw_assignments where task_id = ${taskId} order by key`;

const modelCalls = async (assignmentId: string) =>
  Number(
    (
      await sql`select count(*)::int as n from wb_model_calls where assignment_id = ${assignmentId}`
    ).at(0)?.n,
  );

/** The model dies (the process is killed) on any prompt that carries the marker. */
function dyingModel(marker: string): ModelPort {
  const base = createScriptedModel();
  return {
    ...base,
    generate: (request) =>
      request.prompt.includes(marker)
        ? Promise.reject(new Error('process killed'))
        : base.generate(request),
  };
}

describe('independent workers resume from committed state', { timeout: 90_000 }, () => {
  it('lets a fresh coordinator finish the graph without re-running completed nodes', async () => {
    const first = segmentDeps(sql, { model: dyingModel('KILLME') });
    const { taskId, plan } = await proposedTask(
      first,
      'Which feature-flag service should we adopt?',
      (content) => {
        const [a, b] = content.assignments;
        return chained({ ...content, assignments: [a, { ...b, brief: `${b.brief} KILLME` }] });
      },
    );
    await approve(first, taskId, plan);
    await expect(drain(first)).rejects.toThrow('process killed');

    const [doneBefore, hungBefore] = await nodes(taskId);
    expect([doneBefore.status, hungBefore.status]).toEqual(['succeeded', 'running']);
    const committed = JSON.stringify([doneBefore.output, doneBefore.finished_at]);
    await sql`update tw_jobs set state = 'running', attempts = 1, lease_until = now() - interval '1 minute' where kind = 'assignment' and ref like ${`${hungBefore.id}:%`}`;

    let freshCalls = 0;
    const base = createScriptedModel();
    const fresh = segmentDeps(sql, {
      model: {
        ...base,
        generate: (request) => {
          freshCalls += 1;
          return base.generate(request);
        },
      },
    });
    await drain(fresh);

    const [doneAfter, hungAfter] = await nodes(taskId);
    expect([doneAfter.status, hungAfter.status]).toEqual(['succeeded', 'succeeded']);
    expect(JSON.stringify([doneAfter.output, doneAfter.finished_at])).toBe(committed);
    expect(await modelCalls(doneAfter.id)).toBe(1);
    expect(await modelCalls(hungAfter.id)).toBe(2);
    expect(freshCalls).toBeGreaterThan(0);
    expect((await taskDetail(fresh, alice, taskId))!.task.status).not.toBe('running');
  });
});
