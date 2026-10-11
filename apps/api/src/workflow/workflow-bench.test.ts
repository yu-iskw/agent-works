import { expect, it } from 'vitest';

import { createMemoryLedgerPort } from '../ports/memory/ledger-port.js';
import { createMemoryWorkflowPort } from '../ports/memory/workflow.js';

import { createLocalEngine } from './local-engine.js';
import { createMemoryWorkflowLog } from './workflow-log.js';

const stepCount = 20;
const perStepBudgetMs = 50;
const resumeBudgetMs = 2_000;

function plan(taskId: string, count: number) {
  const steps = [];
  for (let index = 0; index < count; index += 1) {
    const stepId = `step_${String(index + 1).padStart(4, '0')}`;
    steps.push({ id: stepId, run: () => Promise.resolve(stepId) });
  }
  return { taskId, subject: 'alice', steps };
}

it('keeps per-step overhead at or below 50 ms and resume at or below 2 s', async () => {
  const workflow = createMemoryWorkflowPort();
  const log = createMemoryWorkflowLog();
  const ledger = createMemoryLedgerPort();
  const engine = createLocalEngine({ workflow, log, ledger });
  const full = plan('task-bench', stepCount);
  const started = performance.now();
  const finished = await engine.run(full);
  const perStep = (performance.now() - started) / stepCount;
  expect(finished.status).toBe('COMPLETED');
  expect(perStep).toBeLessThanOrEqual(perStepBudgetMs);

  const cursor = stepIdAt(full.steps, 10);
  await workflow.save({ taskId: 'task-resume', stepId: cursor, status: 'RUNNING' });
  const resumePlan = plan('task-resume', stepCount);
  const resumeStarted = performance.now();
  const resumed = await createLocalEngine({ workflow, log, ledger }).run(resumePlan);
  expect(performance.now() - resumeStarted).toBeLessThanOrEqual(resumeBudgetMs);
  expect(resumed.message).toBe(`resumed from ${cursor}`);
  expect(resumed.status).toBe('COMPLETED');
});

function stepIdAt(steps: readonly { readonly id: string }[], index: number): string {
  const step = steps.at(index);
  if (step === undefined) throw new Error('step');
  return step.id;
}
