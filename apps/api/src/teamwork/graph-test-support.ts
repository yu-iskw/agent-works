import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createSealer } from '@agent-works/domain/sealer';

import { ModelError } from '../workbench/model-port.js';

import { createStarterTeam, seedCatalog } from './catalog.js';
import { readSegmentConfig } from './config.js';
import { createModelGate } from './model.js';
import { createScriptedModel } from './scripted-model.js';
import { createFixtureSources } from './sources/fixture.js';
import { createTask, decidePlan, editPlan, taskDetail } from './tasks.js';
import { createWorker } from './worker.js';

import type { Deps, Member } from './context.js';
import type { ModelErrorCode, ModelPort } from '../workbench/model-port.js';
import type { PlanContent } from '@agent-works/domain/teamwork';
import type postgres from 'postgres';

/** Test-only harness for the AGT-01 and AGT-00 graph tests: one segment on the scripted model. */
export const alice: Member = { sub: 'local-test:alice', email: 'alice@local.test' };
const root = new URL('../../../../', import.meta.url).pathname;

/** The scripted model, except a contribution whose prompt carries `marker` fails with `code`. */
export function failingModel(marker: string, code: ModelErrorCode): ModelPort {
  const base = createScriptedModel();
  return {
    ...base,
    generate: (request) =>
      request.prompt.includes(marker)
        ? Promise.reject(new ModelError(code))
        : base.generate(request),
  };
}

export function segmentDeps(
  sql: postgres.Sql,
  options: { readonly model?: ModelPort; readonly now?: () => Date } = {},
): Deps {
  const config = readSegmentConfig({
    AW_SEGMENT_ID: 'alpha',
    AW_IDENTITY: 'local-test',
    AW_SOURCE_MODE: 'fixture',
    AW_LOCAL_TEST_MEMBERS: 'alice@local.test',
    AW_KEY_DIR: mkdtempSync(join(tmpdir(), 'tw-keys-')),
  });
  const now = options.now ?? (() => new Date());
  return {
    sql,
    config,
    gate: createModelGate({
      sql,
      segment: 'alpha',
      model: options.model ?? createScriptedModel(),
      limit: 200,
      now,
      sleep: () => Promise.resolve(),
    }),
    sources: createFixtureSources({ root, segment: 'alpha', sql, faults: true }),
    sealer: createSealer(Buffer.alloc(32, 1), 'test'),
    now,
    newId: () => crypto.randomUUID(),
    fetch,
  };
}

const throwing = (error: unknown): never => {
  throw error;
};

export const drain = (d: Deps) => createWorker(d, throwing).drain();

type Plan = { readonly version: number; readonly digest: string; readonly content: PlanContent };

/**
 * A coordinated task whose coordinator plan is proposed. `change` rewrites the plan as the member
 * would (edit becomes the proposed version); `approve` then dispatches it.
 */
export async function proposedTask(
  d: Deps,
  question: string,
  change?: (content: PlanContent) => PlanContent,
): Promise<{ taskId: string; plan: Plan }> {
  await seedCatalog(d);
  const teammates = await createStarterTeam(d, alice);
  const coordinator = teammates.find((t) => t.name === 'Coordinator')?.id ?? '';
  const { task } = await createTask(d, alice, {
    clientRequestId: crypto.randomUUID(),
    workflow: 'research_brief',
    mode: 'coordinated',
    scope: { question, metrics: null, repository: null, issueNumber: null },
    resultOwner: coordinator,
    conversationId: null,
    assignments: [],
  });
  await drain(d);
  let plans = (await taskDetail(d, alice, task.id))!.plans;
  if (change !== undefined) {
    const proposed = plans.at(-1)!;
    await editPlan(d, alice, task.id, {
      baseVersion: proposed.version,
      content: change(proposed.content),
    });
    plans = (await taskDetail(d, alice, task.id))!.plans;
  }
  const live = plans.at(-1)!;
  return {
    taskId: task.id,
    plan: { version: live.version, digest: live.digest, content: live.content },
  };
}

export async function approve(d: Deps, taskId: string, plan: Plan): Promise<void> {
  await decidePlan(d, alice, taskId, {
    version: plan.version,
    expectedDigest: plan.digest,
    decision: 'approve',
  });
}

/** The second node waits for the first. */
export const chained = (content: PlanContent): PlanContent => {
  const [first, second] = content.assignments;
  return { ...content, assignments: [first, { ...second, dependsOn: [first.key] }] };
};
