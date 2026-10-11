import { expect, it } from 'vitest';

import { createMemoryLedgerPort } from '../ports/memory/ledger-port.js';
import { createMemoryWorkflowPort } from '../ports/memory/workflow.js';

import { createLocalEngine } from './local-engine.js';
import { createMemoryWorkflowLog } from './workflow-log.js';

import type { WorkflowPlan, WorkflowStep } from './local-engine.js';
import type { LedgerPort } from '../ports/ledger-port.js';
import type { TaskSubmit, WorkflowSignal } from '@agent-works/domain';

const request: TaskSubmit = {
  objective: 'Summarize the runbook',
  skillId: 'ask',
  sourceAllowlist: ['drive'],
  requestedOutputs: ['answer'],
  executionPolicy: { mode: 'interactive', budgetUsd: 0.1, deadlineSeconds: 30 },
};

function services(events: string[] = []) {
  const workflow = createMemoryWorkflowPort();
  const log = createMemoryWorkflowLog();
  const inner = createMemoryLedgerPort();
  const ledger: LedgerPort = {
    submit: (subject, body, idempotencyKey) => inner.submit(subject, body, idempotencyKey),
    read: (subject, taskId) => inner.read(subject, taskId),
    append(event) {
      events.push(event.event.eventId);
      return inner.append(event);
    },
  };
  return { workflow, log, ledger, engine: createLocalEngine({ workflow, log, ledger }) };
}

function hold(): { promise: Promise<void>; release: () => void } {
  const box: { release: () => void } = { release: () => {} };
  const promise = new Promise<void>((resolve) => {
    box.release = resolve;
  });
  return { promise, release: () => box.release() };
}

function steps(
  block: { entered: () => void; release: Promise<void> } | undefined,
): readonly WorkflowStep[] {
  return [
    { id: 'step_0001', run: () => Promise.resolve('r1') },
    { id: 'step_0002', run: () => Promise.resolve('r2') },
    {
      id: 'step_0003',
      run: async (context) => {
        block?.entered();
        if (block !== undefined) await block.release;
        if (context.signal.aborted) throw new Error('aborted');
        return 'r3';
      },
    },
  ];
}

it('resumes a killed worker from the last checkpoint and finishes the task', async () => {
  const { workflow, log, ledger } = services();
  const first = createLocalEngine({ workflow, log, ledger });
  const entered = hold();
  const release = hold();
  const running = first.run({
    taskId: 'task-1',
    subject: 'alice',
    steps: steps({ entered: entered.release, release: release.promise }),
  });
  await entered.promise;
  first.halt('task-1');
  release.release();
  const stopped = await running;
  expect(stopped.status).toBe('RUNNING');
  expect(stopped.receipts.map((row) => row.stepId)).toEqual(['step_0001', 'step_0002']);

  const second = createLocalEngine({ workflow, log, ledger });
  const report = await second.run({ taskId: 'task-1', subject: 'alice', steps: steps(undefined) });
  expect(report.message).toBe('resumed from step_0003');
  expect(report.status).toBe('COMPLETED');
  expect(report.receipts).toEqual([
    { stepId: 'step_0001', body: 'r1' },
    { stepId: 'step_0002', body: 'r2' },
    { stepId: 'step_0003', body: 'r3' },
  ]);
});

it('runs a step once when the same resume signal arrives twice', async () => {
  const events: string[] = [];
  const { engine } = services(events);
  let runs = 0;
  const plan: WorkflowPlan = {
    taskId: 'task-dup',
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
  const signal: WorkflowSignal = { taskId: 'task-dup', signalId: 'sig-1', kind: 'resume' };
  const first = await engine.deliver(signal, plan);
  const second = await engine.deliver(signal, plan);
  expect(first.effect).toBe('resumed');
  expect(second.effect).toBe('duplicate');
  expect(runs).toBe(1);
  expect(second.report.receipts).toEqual([{ stepId: 'step_0001', body: 'once' }]);
  expect(events).toEqual(['workflow:task-dup:step_0001:SUCCESS']);
});

it('fails the step after the attempt budget is spent', async () => {
  const { engine } = services();
  let tries = 0;
  const report = await engine.run({
    taskId: 'task-retry',
    subject: 'alice',
    steps: [
      {
        id: 'step_0001',
        run: () => {
          tries += 1;
          return Promise.reject(new Error('no'));
        },
      },
    ],
  });
  expect(tries).toBe(3);
  expect(report.status).toBe('FAILED');
  expect(report.receipts).toEqual([]);
});

it('keeps the finished receipt and skips later steps when cancelled mid-write', async () => {
  const { ledger, engine } = services();
  const accepted = await ledger.submit('alice', request, 'idem-1');
  const taskId = accepted.taskId;
  const entered = hold();
  const release = hold();
  let later = 0;
  const running = engine.run({
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
  expect(await engine.cancel('bob', taskId, 'cancel-bob')).toEqual({
    ok: false,
    reason: 'not_found',
  });
  const cancelled = await engine.cancel('alice', taskId, 'cancel-1');
  release.release();
  const report = await running;
  expect(cancelled).toEqual({ ok: true, status: 'CANCELLED', duplicate: false });
  expect(await engine.cancel('alice', taskId, 'cancel-1')).toEqual({
    ok: true,
    status: 'CANCELLED',
    duplicate: true,
  });
  expect(report.status).toBe('CANCELLED');
  expect(report.receipts).toEqual([{ stepId: 'step_0001', body: 'receipt-1' }]);
  expect(later).toBe(0);
});

it('does not run the next step when cancel lands while the receipt log is read', async () => {
  const workflow = createMemoryWorkflowPort();
  const inner = createMemoryWorkflowLog();
  const ledger = createMemoryLedgerPort();
  const accepted = await ledger.submit('alice', request, 'idem-between');
  const taskId = accepted.taskId;
  const gate = hold();
  const entered = hold();
  let lists = 0;
  const log = {
    put: (id: string, stepId: string, body: string) => inner.put(id, stepId, body),
    bump: (id: string, stepId: string) => inner.bump(id, stepId),
    async list(id: string) {
      lists += 1;
      if (lists === 2) {
        entered.release();
        await gate.promise;
      }
      return inner.list(id);
    },
  };
  const engine = createLocalEngine({ workflow, log, ledger });
  let later = 0;
  const plan: WorkflowPlan = {
    taskId,
    subject: 'alice',
    steps: [
      { id: 'step_0001', run: () => Promise.resolve('receipt-1') },
      {
        id: 'step_0002',
        run: () => {
          later += 1;
          return Promise.resolve('receipt-2');
        },
      },
    ],
  };
  const running = engine.run(plan);
  await entered.promise;
  const cancelled = await engine.cancel('alice', taskId, 'cancel-between');
  gate.release();
  const report = await running;
  expect(cancelled).toEqual({ ok: true, status: 'CANCELLED', duplicate: false });
  expect(report.status).toBe('CANCELLED');
  expect(report.receipts).toEqual([{ stepId: 'step_0001', body: 'receipt-1' }]);
  expect(later).toBe(0);

  const second = createLocalEngine({ workflow, log: inner, ledger });
  const again = await second.run(plan);
  expect(again.status).toBe('CANCELLED');
  expect(later).toBe(0);
});

it('leaves a completed task completed when cancel arrives afterward', async () => {
  const { workflow, ledger, engine } = services();
  const accepted = await ledger.submit('alice', request, 'idem-done');
  const taskId = accepted.taskId;
  const report = await engine.run({
    taskId,
    subject: 'alice',
    steps: [{ id: 'step_0001', run: () => Promise.resolve('done') }],
  });
  expect(report.status).toBe('COMPLETED');
  expect(await engine.cancel('alice', taskId, 'cancel-late')).toEqual({
    ok: true,
    status: 'COMPLETED',
    duplicate: false,
  });
  expect(await workflow.read(taskId)).toMatchObject({ status: 'COMPLETED', stepId: 'step_0001' });
});

it('appends the step event on the next run when the ledger write fails after the receipt', async () => {
  const workflow = createMemoryWorkflowPort();
  const log = createMemoryWorkflowLog();
  const inner = createMemoryLedgerPort();
  const events: string[] = [];
  let failed = false;
  const ledger: LedgerPort = {
    submit: (subject, body, idempotencyKey) => inner.submit(subject, body, idempotencyKey),
    read: (subject, taskId) => inner.read(subject, taskId),
    append(event) {
      if (!failed) {
        failed = true;
        return Promise.reject(new Error('append down'));
      }
      events.push(event.event.eventId);
      return inner.append(event);
    },
  };
  const engine = createLocalEngine({ workflow, log, ledger });
  const plan: WorkflowPlan = {
    taskId: 'task-replay',
    subject: 'alice',
    steps: [{ id: 'step_0001', run: () => Promise.resolve('kept') }],
  };
  await expect(engine.run(plan)).rejects.toThrow('append down');
  const report = await engine.run(plan);
  expect(report.status).toBe('COMPLETED');
  expect(report.receipts).toEqual([{ stepId: 'step_0001', body: 'kept' }]);
  expect(events).toEqual(['workflow:task-replay:step_0001:SUCCESS']);
});

it('joins a second run to the walk already in flight', async () => {
  const { engine } = services();
  let runs = 0;
  const entered = hold();
  const release = hold();
  const plan: WorkflowPlan = {
    taskId: 'task-join',
    subject: 'alice',
    steps: [
      {
        id: 'step_0001',
        run: async () => {
          runs += 1;
          entered.release();
          await release.promise;
          return 'once';
        },
      },
    ],
  };
  const first = engine.run(plan);
  await entered.promise;
  const second = engine.run(plan);
  release.release();
  const [left, right] = await Promise.all([first, second]);
  expect(runs).toBe(1);
  expect(left).toBe(right);
  expect(right.status).toBe('COMPLETED');
});

it('keeps the receipt when the step returns after cancel', async () => {
  const { ledger, engine } = services();
  const accepted = await ledger.submit('alice', request, 'idem-finish');
  const taskId = accepted.taskId;
  const entered = hold();
  const release = hold();
  let later = 0;
  const running = engine.run({
    taskId,
    subject: 'alice',
    steps: [
      {
        id: 'step_0001',
        run: async () => {
          entered.release();
          await release.promise;
          return 'kept';
        },
      },
      {
        id: 'step_0002',
        run: () => {
          later += 1;
          return Promise.resolve('later');
        },
      },
    ],
  });
  await entered.promise;
  const cancelled = await engine.cancel('alice', taskId, 'cancel-finish');
  release.release();
  const report = await running;
  expect(cancelled).toEqual({ ok: true, status: 'CANCELLED', duplicate: false });
  expect(report.status).toBe('CANCELLED');
  expect(report.receipts).toEqual([{ stepId: 'step_0001', body: 'kept' }]);
  expect(later).toBe(0);
});

it('stops a second engine when cancel is stored on the shared checkpoint', async () => {
  const workflow = createMemoryWorkflowPort();
  const log = createMemoryWorkflowLog();
  const ledger = createMemoryLedgerPort();
  const accepted = await ledger.submit('alice', request, 'idem-other');
  const taskId = accepted.taskId;
  const entered = hold();
  const release = hold();
  let later = 0;
  const runner = createLocalEngine({ workflow, log, ledger });
  const canceller = createLocalEngine({ workflow, log, ledger });
  const running = runner.run({
    taskId,
    subject: 'alice',
    steps: [
      {
        id: 'step_0001',
        run: async () => {
          entered.release();
          await release.promise;
          return 'kept';
        },
      },
      {
        id: 'step_0002',
        run: () => {
          later += 1;
          return Promise.resolve('no');
        },
      },
    ],
  });
  await entered.promise;
  const cancelled = await canceller.cancel('alice', taskId, 'cancel-other');
  release.release();
  const report = await running;
  expect(cancelled).toEqual({ ok: true, status: 'CANCELLED', duplicate: false });
  expect(report.status).toBe('CANCELLED');
  expect(report.receipts).toEqual([{ stepId: 'step_0001', body: 'kept' }]);
  expect(later).toBe(0);
  expect(await workflow.read(taskId)).toMatchObject({ status: 'CANCELLED' });
});

it('accepts a second cancel signal after the task is already cancelled', async () => {
  const workflow = createMemoryWorkflowPort();
  const log = createMemoryWorkflowLog();
  const ledger = createMemoryLedgerPort();
  let clock = Date.parse('2026-01-01T00:00:00.000Z');
  const engine = createLocalEngine({
    workflow,
    log,
    ledger,
    now: () => new Date(clock),
  });
  const accepted = await ledger.submit('alice', request, 'idem-again');
  const taskId = accepted.taskId;
  const entered = hold();
  const release = hold();
  const walk = engine.run({
    taskId,
    subject: 'alice',
    steps: [
      {
        id: 'step_0001',
        run: async () => {
          entered.release();
          await release.promise;
          return 'kept';
        },
      },
    ],
  });
  await entered.promise;
  expect(await engine.cancel('alice', taskId, 'cancel-a')).toEqual({
    ok: true,
    status: 'CANCELLED',
    duplicate: false,
  });
  clock += 1000;
  expect(await engine.cancel('alice', taskId, 'cancel-b')).toEqual({
    ok: true,
    status: 'CANCELLED',
    duplicate: false,
  });
  release.release();
  expect((await walk).status).toBe('CANCELLED');
});

it('finishes a cancel when the signal was stored before the checkpoint', async () => {
  const { workflow, ledger, engine } = services();
  const accepted = await ledger.submit('alice', request, 'idem-heal');
  const taskId = accepted.taskId;
  await workflow.signal({ taskId, signalId: 'cancel-1', kind: 'cancel' });
  await workflow.save({ taskId, stepId: 'step_0001', status: 'RUNNING' });
  expect(await engine.cancel('alice', taskId, 'cancel-1')).toEqual({
    ok: true,
    status: 'CANCELLED',
    duplicate: true,
  });
  expect(await workflow.read(taskId)).toMatchObject({ status: 'CANCELLED' });
});
