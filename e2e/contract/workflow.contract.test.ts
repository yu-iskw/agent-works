import { randomUUID } from 'node:crypto';

import { afterAll, beforeAll, expect, it } from 'vitest';

import { createMemoryLedgerPort } from '../../apps/api/src/ports/memory/ledger-port.js';
import { createMemoryWorkflowPort } from '../../apps/api/src/ports/memory/workflow.js';
import { startStack } from '../../apps/api/src/testing/stack.js';
import { createLocalEngine } from '../../apps/api/src/workflow/local-engine.js';
import { workflowRuntime } from '../../apps/api/src/workflow/runtime.js';
import { createMemoryWorkflowLog } from '../../apps/api/src/workflow/workflow-log.js';
import { writePng } from '../png.mjs';
import { appendResult } from '../results.mjs';

import type { Stack } from '../../apps/api/src/testing/stack.js';
import type { TaskSubmit } from '@agent-works/domain';

const submit: TaskSubmit = {
  objective: 'Summarize the runbook',
  skillId: 'ask',
  sourceAllowlist: ['drive'],
  requestedOutputs: ['answer'],
  executionPolicy: { mode: 'interactive', budgetUsd: 0.1, deadlineSeconds: 30 },
};

let stack: Stack;

beforeAll(async () => {
  process.env.AW_TASKS_CANCEL = 'real';
  stack = await startStack();
  process.env.IAP_JWKS_URL = `${stack.iapUrl}/jwks`;
  process.env.IAP_ISSUER = 'https://fake-iap.local';
  process.env.IAP_AUDIENCE = 'agent-works-dev';
});

afterAll(async () => {
  await stack?.close();
  delete process.env.AW_TASKS_CANCEL;
  delete process.env.IAP_JWKS_URL;
  delete process.env.IAP_ISSUER;
  delete process.env.IAP_AUDIENCE;
});

it('workflow.resume-after-kill', async () => {
  const workflow = createMemoryWorkflowPort();
  const log = createMemoryWorkflowLog();
  const ledger = createMemoryLedgerPort();
  const entered = hold();
  const release = hold();
  const first = createLocalEngine({ workflow, log, ledger });
  const running = first.run({
    taskId: 'task-resume',
    subject: 'alice',
    steps: [
      { id: 'step_0001', run: () => Promise.resolve('r1') },
      { id: 'step_0002', run: () => Promise.resolve('r2') },
      {
        id: 'step_0003',
        run: async (context) => {
          entered.release();
          await release.promise;
          if (context.signal.aborted) throw new Error('aborted');
          return 'r3';
        },
      },
    ],
  });
  await entered.promise;
  first.halt('task-resume');
  release.release();
  expect((await running).receipts.map((row) => row.stepId)).toEqual(['step_0001', 'step_0002']);
  const report = await createLocalEngine({ workflow, log, ledger }).run({
    taskId: 'task-resume',
    subject: 'alice',
    steps: [
      { id: 'step_0001', run: () => Promise.resolve('r1') },
      { id: 'step_0002', run: () => Promise.resolve('r2') },
      { id: 'step_0003', run: () => Promise.resolve('r3') },
    ],
  });
  expect(report.message).toBe('resumed from step_0003');
  expect(report.status).toBe('COMPLETED');
  expect(report.receipts.map((row) => row.body)).toEqual(['r1', 'r2', 'r3']);
  record('workflow.resume-after-kill');
});

it('workflow.cancel-mid-write', async () => {
  const accepted = await workflowRuntime.ledger.submit('alice', submit, randomUUID());
  const taskId = accepted.taskId;
  const entered = hold();
  const release = hold();
  let later = 0;
  const running = workflowRuntime.engine.run({
    taskId,
    subject: 'alice',
    steps: [
      { id: 'step_0001', run: () => Promise.resolve('receipt-1') },
      {
        id: 'step_0002',
        run: async (context) => {
          entered.release();
          await release.promise;
          if (context.signal.aborted) throw new Error('aborted');
          return 'receipt-2';
        },
      },
      {
        id: 'step_0003',
        run: () => {
          later += 1;
          return Promise.resolve('receipt-3');
        },
      },
    ],
  });
  await entered.promise;
  const response = await postCancel(taskId, 'alice', 'cancel-key');
  expect(response.status).toBe(200);
  expect(response.body).toEqual({ taskId, status: 'CANCELLED' });
  release.release();
  const report = await running;
  expect(report.status).toBe('CANCELLED');
  expect(report.receipts).toEqual([{ stepId: 'step_0001', body: 'receipt-1' }]);
  expect(later).toBe(0);
  record('workflow.cancel-mid-write');
});

it('workflow.duplicate-signal', async () => {
  const workflow = createMemoryWorkflowPort();
  const log = createMemoryWorkflowLog();
  const ledger = createMemoryLedgerPort();
  const engine = createLocalEngine({ workflow, log, ledger });
  let runs = 0;
  const plan = {
    taskId: 'task-signal',
    subject: 'alice',
    steps: [
      {
        id: 'step_0001',
        run: () => {
          runs += 1;
          return Promise.resolve('once');
        },
      },
    ],
  };
  const signal = { taskId: 'task-signal', signalId: 'sig-1', kind: 'resume' as const };
  expect((await engine.deliver(signal, plan)).effect).toBe('resumed');
  expect((await engine.deliver(signal, plan)).effect).toBe('duplicate');
  expect(runs).toBe(1);
  record('workflow.duplicate-signal');
});

function record(id: string): void {
  appendResult({ id, status: 'passed' });
  writePng(`e2e/artifacts/${id}/${id.replaceAll('.', '-')}.png`, 'passed');
}

async function postCancel(
  taskId: string,
  user: string,
  idempotencyKey: string,
): Promise<{ status: number; body: unknown }> {
  const response = await fetch(`${stack.iapUrl}/v1/tasks/${taskId}:cancel`, {
    method: 'POST',
    headers: { 'x-fake-user': user, 'idempotency-key': idempotencyKey },
  });
  return { status: response.status, body: await response.json() };
}

function hold(): { promise: Promise<void>; release: () => void } {
  const box: { release: () => void } = { release: () => {} };
  const promise = new Promise<void>((resolve) => {
    box.release = resolve;
  });
  return { promise, release: () => box.release() };
}
