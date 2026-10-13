import { readFileSync } from 'node:fs';

import { transition } from '@agent-works/domain';
import { describe, expect, it, vi } from 'vitest';

import { createMemoryWorkflowPort } from '../ports/memory/workflow.js';

import {
  advanceCloudWorkflow,
  cloudStepKey,
  cloudTaskLabel,
  createCloudWorkflowsPort,
  generateCloudWorkflowDefinition,
  recoverCloudWorkflow,
} from './cloud-workflows.js';
import { createMemoryWorkflowLog } from './workflow-log.js';

import type {
  CloudRequest,
  CloudStep,
  CloudWorkerDeps,
  CloudWorkflowDeps,
} from './cloud-workflows.js';
import type { LedgerPort } from '../ports/ledger-port.js';
import type { Task, TaskStatus } from '@agent-works/domain';

const workflowName = 'projects/pilot-dev/locations/asia-northeast1/workflows/pilot-durable-tasks';
const executionName = `${workflowName}/executions/execution-1`;
const base = 'https://workflowexecutions.googleapis.com/v1/';
const taskId = 'task-1';
const broker = {
  brokerUrl: 'https://broker.example.test/workflow/tick',
  audience: 'https://broker.example.test',
};

function fixture(name: string): unknown {
  // Internal test fixture names only.

  return JSON.parse(
    // eslint-disable-next-line security/detect-non-literal-fs-filename
    readFileSync(new URL(`./__fixtures__/cloud-workflows/${name}.json`, import.meta.url), 'utf8'),
  ) as unknown;
}

function task(status: TaskStatus = 'RUNNING'): Task {
  return {
    id: taskId,
    createdBySub: 'alice',
    status,
    objectiveDigest: 'digest',
    skillVersion: 'test@1',
    agentVersion: 'test@1',
    policyVersion: 'test@1',
    budget: 1,
    version: 1,
    createdAt: '2026-10-13T00:00:00.000Z',
    updatedAt: '2026-10-13T00:00:00.000Z',
  };
}

/** Ledger fake enforces the real domain transitions and version checks. */
function ledgerState(initial = task()) {
  let current = initial;
  const events: { status: TaskStatus; stepId: string; receipt?: string }[] = [];
  const ledger: LedgerPort = {
    read: vi.fn((subject: string, id: string) =>
      Promise.resolve(subject === 'alice' && id === taskId ? current : undefined),
    ),
    submit: vi.fn(() => Promise.reject(new Error('unused submit'))),
    append: vi.fn(() => Promise.resolve('recorded' as const)),
    readOutbox: vi.fn(() => Promise.resolve(undefined)),
  };
  const commit = vi.fn<CloudWorkerDeps['commit']>((prior, update) => {
    if (prior.version !== current.version)
      return Promise.reject(new Error('ledger version conflict'));
    if (prior.status !== update.status) current = transition(current, update.status);
    if (!events.some((event) => JSON.stringify(event) === JSON.stringify(update)))
      events.push(update);
    return Promise.resolve();
  });
  return {
    ledger,
    commit,
    events,
    current: () => current,
    replace: (value: Task) => {
      current = value;
    },
  };
}

function setup(initial = task()) {
  const state = ledgerState(initial);
  const checkpoints = createMemoryWorkflowPort();
  const calls: CloudRequest[] = [];
  let executions: unknown[] = [];
  let callbackAvailable = true;
  let rejectCreate = false;
  let rejectCallback = false;
  const callbackReply = (): Promise<unknown> =>
    rejectCallback ? Promise.reject(new Error('callback unavailable')) : Promise.resolve({});
  const transport = {
    request: vi.fn((request: CloudRequest): Promise<unknown> => {
      calls.push(structuredClone(request));
      if (request.method === 'GET' && request.url.includes('/executions?'))
        return Promise.resolve({ executions });
      if (request.method === 'GET' && request.url.includes('/callbacks?')) {
        return Promise.resolve({
          callbacks: callbackAvailable
            ? [{ name: `${executionName}/callback/callback-1`, method: 'POST' }]
            : [],
        });
      }
      if (request.url.endsWith('/executions')) {
        executions = [
          { name: executionName, state: 'ACTIVE', labels: { task: cloudTaskLabel(taskId) } },
        ];
        if (rejectCreate) return Promise.reject(new Error('response lost'));
        return Promise.resolve(executions[0]);
      }
      if (request.url.includes('/callbacks/')) {
        return callbackReply();
      }
      if (request.url.endsWith(':cancel')) {
        executions = [];
        return Promise.resolve({});
      }
      return Promise.reject(new Error('unexpected request'));
    }),
  };
  // Sequential tests supply a trivial lock; separate tests exercise a shared serial lock.
  const deps: CloudWorkflowDeps = {
    workflowName,
    transport,
    checkpoints,
    ledger: state.ledger,
    subjectForTask: () => Promise.resolve('alice'),
    withTaskLock: (_id, operation) => operation(),
    authorizeResume: vi.fn(() => Promise.resolve()),
    cancelInLedger: vi.fn<CloudWorkflowDeps['cancelInLedger']>((prior) =>
      state.commit(prior, { status: 'CANCELLED', stepId: 'cancel' }),
    ),
  };
  const port = createCloudWorkflowsPort(deps);
  const worker: CloudWorkerDeps = {
    ledger: state.ledger,
    checkpoints,
    log: createMemoryWorkflowLog(),
    subjectForTask: deps.subjectForTask,
    withTaskLock: deps.withTaskLock,
    commit: state.commit,
    steps: [],
  };
  return {
    ...state,
    deps,
    port,
    checkpoints,
    calls,
    worker,
    setExecutions: (value: unknown[]) => {
      executions = value;
    },
    active: () => {
      executions = [
        { name: executionName, state: 'ACTIVE', labels: { task: cloudTaskLabel(taskId) } },
      ];
    },
    noCallbacks: () => {
      callbackAvailable = false;
    },
    loseCreateResponse: () => {
      rejectCreate = true;
    },
    failCallback: () => {
      rejectCallback = true;
    },
    restoreCallback: () => {
      rejectCallback = false;
    },
  };
}

function externalStep() {
  const receipts = new Map<string, string>();
  let writes = 0;
  const step: CloudStep = {
    id: 'write-draft',
    payloadDigest: 'a'.repeat(64),
    authorize: vi.fn(() => Promise.resolve('allow' as const)),
    reconcile: vi.fn((key: string) =>
      Promise.resolve(
        receipts.has(key)
          ? { kind: 'found' as const, receipt: receipts.get(key) ?? '' }
          : { kind: 'absent' as const },
      ),
    ),
    execute: vi.fn<CloudStep['execute']>(({ idempotencyKey }) => {
      const existing = receipts.get(idempotencyKey);
      if (existing !== undefined) return Promise.resolve(existing);
      writes += 1;
      receipts.set(idempotencyKey, 'draft:external-1');
      return Promise.resolve('draft:external-1');
    }),
  };
  return { step, receipts, writes: () => writes };
}

function serialLock(): CloudWorkflowDeps['withTaskLock'] {
  let tail = Promise.resolve();
  return <T>(_id: string, operation: () => Promise<T>): Promise<T> => {
    const result = tail.then(operation);
    tail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  };
}

const resume = { taskId, signalId: 'signal-1', kind: 'resume' as const };
const cancel = { taskId, signalId: 'cancel-1', kind: 'cancel' as const };

describe('Cloud Workflows definition', () => {
  it('matches the reviewed golden definition', () => {
    expect(JSON.parse(generateCloudWorkflowDefinition(broker))).toEqual(fixture('definition'));
  });
  it.each([
    { ...broker, brokerUrl: 'http://broker.example.test/tick' },
    { ...broker, brokerUrl: 'https://user:password@broker.example.test/tick' },
    { ...broker, brokerUrl: 'https://broker.example.test/tick?token=secret' },
    { ...broker, audience: 'https://other.example.test' },
    { ...broker, waitSeconds: 0 },
    { ...broker, waitSeconds: 86401 },
    { ...broker, waitSeconds: 1.5 },
  ])('rejects unsafe configuration %j', (input) => {
    expect(() => generateCloudWorkflowDefinition(input)).toThrow();
  });
});

describe('Cloud WorkflowPort and dispatch recovery', () => {
  it('creates only after persisting a ledger-consistent checkpoint', async () => {
    const ctx = setup();
    expect(await ctx.port.save({ taskId, stepId: 'write-draft', status: 'RUNNING' })).toEqual({
      taskId,
      stepId: 'write-draft',
      status: 'RUNNING',
    });
    expect(ctx.calls).toEqual(fixture('create-requests'));
  });
  it('rejects a proposed status that has not been committed in the ledger', async () => {
    const ctx = setup();
    await expect(
      ctx.port.save({ taskId, stepId: 'write-draft', status: 'COMPLETED' }),
    ).rejects.toThrow('disagrees');
    expect(await ctx.checkpoints.read(taskId)).toBeUndefined();
    expect(ctx.calls).toEqual([]);
  });
  it('uses ledger status rather than checkpoint or cloud execution status', async () => {
    const ctx = setup(task('CANCELLED'));
    await ctx.checkpoints.save({ taskId, stepId: 'write-draft', status: 'RUNNING' });
    expect(await ctx.port.read(taskId)).toEqual({
      taskId,
      stepId: 'write-draft',
      status: 'CANCELLED',
    });
    expect(ctx.calls).toEqual([]);
  });
  it('has no fabricated cursor for a task without checkpoints', async () => {
    expect(await setup().port.read(taskId)).toBeUndefined();
  });
  it('rejects unknown tasks without contacting cloud', async () => {
    const ctx = setup();
    await expect(ctx.port.read('unknown')).rejects.toThrow('not found');
    await expect(ctx.port.signal({ ...resume, taskId: 'unknown' })).rejects.toThrow('not found');
    expect(ctx.calls).toEqual([]);
  });
  it('validates resource names and shared signal schema', async () => {
    const ctx = setup();
    expect(() =>
      createCloudWorkflowsPort({ ...ctx.deps, workflowName: 'https://attacker.example' }),
    ).toThrow();
    await expect(ctx.port.signal({ ...resume, signalId: '' })).rejects.toThrow();
    expect(ctx.calls).toEqual([]);
  });
  it('rechecks authorization for every duplicate callback and uses golden requests', async () => {
    const ctx = setup(task('WAITING_APPROVAL'));
    ctx.active();
    expect(await ctx.port.signal(resume)).toBe('recorded');
    expect(await ctx.port.signal(resume)).toBe('duplicate');
    expect(ctx.deps.authorizeResume).toHaveBeenCalledTimes(2);
    expect(ctx.calls).toEqual(fixture('duplicate-callback-requests'));
  });
  it('does not record or dispatch an expired authorization', async () => {
    const ctx = setup(task('WAITING_APPROVAL'));
    vi.mocked(ctx.deps.authorizeResume).mockRejectedValue(new Error('authorization expired'));
    await expect(ctx.port.signal(resume)).rejects.toThrow('expired');
    expect(ctx.calls).toEqual(fixture('expired-authorization-requests'));
    expect(await ctx.checkpoints.signal(resume)).toBe('recorded');
  });
  it('repairs a callback failure even when the signal is already recorded', async () => {
    const ctx = setup();
    ctx.active();
    ctx.failCallback();
    await expect(ctx.port.signal(resume)).rejects.toThrow('unavailable');
    ctx.restoreCallback();
    expect(await ctx.port.signal(resume)).toBe('duplicate');
    expect(ctx.calls.filter((call) => call.method === 'POST')).toHaveLength(2);
  });
  it('relies on timed ledger rechecks if the execution has not created a callback', async () => {
    const ctx = setup();
    ctx.active();
    ctx.noCallbacks();
    expect(await ctx.port.signal(resume)).toBe('recorded');
    expect(ctx.calls.filter((call) => call.method === 'POST')).toEqual([]);
  });
  it('commits cancellation before cancelling all matching executions', async () => {
    const ctx = setup();
    ctx.active();
    expect(await ctx.port.signal(cancel)).toBe('recorded');
    expect(ctx.current().status).toBe('CANCELLED');
    expect(ctx.calls).toEqual(fixture('cancel-requests'));
    expect(await ctx.port.signal(cancel)).toBe('duplicate');
    expect(ctx.deps.cancelInLedger).toHaveBeenCalledTimes(1);
  });
  it('refuses remote cancellation when the ledger transaction did not cancel', async () => {
    const ctx = setup();
    ctx.active();
    vi.mocked(ctx.deps.cancelInLedger).mockResolvedValue(undefined);
    await expect(ctx.port.signal(cancel)).rejects.toThrow('not committed');
    expect(ctx.calls).toEqual([]);
  });
  it('cancels leftover executions on terminal checkpoint save', async () => {
    const ctx = setup(task('COMPLETED'));
    ctx.active();
    await ctx.port.save({ taskId, stepId: 'done', status: 'COMPLETED' });
    expect(ctx.calls.at(-1)?.url).toBe(`${base}${executionName}:cancel`);
  });
  it('preserves terminal completion on cancellation', async () => {
    const ctx = setup(task('COMPLETED'));
    await ctx.port.signal(cancel);
    expect(ctx.current().status).toBe('COMPLETED');
    expect(ctx.deps.cancelInLedger).not.toHaveBeenCalled();
  });
  it('recovers a lost create response using remote identity without recreating', async () => {
    const ctx = setup();
    ctx.loseCreateResponse();
    await expect(
      ctx.port.save({ taskId, stepId: 'write-draft', status: 'RUNNING' }),
    ).rejects.toThrow('lost');
    await recoverCloudWorkflow(ctx.deps, taskId);
    expect(ctx.calls).toEqual(fixture('crash-recovery-requests'));
    expect(ctx.calls.filter((call) => call.method === 'POST')).toHaveLength(1);
  });
  it('recovers when a process died after only writing the checkpoint', async () => {
    const ctx = setup();
    await ctx.checkpoints.save({ taskId, stepId: 'write-draft', status: 'RUNNING' });
    await recoverCloudWorkflow(ctx.deps, taskId);
    expect(ctx.calls).toEqual(fixture('create-requests'));
  });
  it('recovers remote cancellation after the ledger became terminal', async () => {
    const ctx = setup(task('CANCELLED'));
    ctx.active();
    await recoverCloudWorkflow(ctx.deps, taskId);
    expect(ctx.calls).toEqual(fixture('cancel-requests'));
  });
  it('serializes dispatch across two adapter instances with the injected shared lock', async () => {
    const ctx = setup();
    const deps = { ...ctx.deps, withTaskLock: serialLock() };
    const first = createCloudWorkflowsPort(deps);
    const second = createCloudWorkflowsPort(deps);
    await Promise.all([
      first.save({ taskId, stepId: 'write-draft', status: 'RUNNING' }),
      second.save({ taskId, stepId: 'write-draft', status: 'RUNNING' }),
    ]);
    expect(ctx.calls.filter((call) => call.method === 'POST')).toHaveLength(1);
  });
  it('does not reuse an execution for a different task or a terminal execution', async () => {
    const ctx = setup();
    ctx.setExecutions([
      { name: executionName, state: 'ACTIVE', labels: { task: cloudTaskLabel('other-task') } },
      {
        name: `${workflowName}/executions/old`,
        state: 'SUCCEEDED',
        labels: { task: cloudTaskLabel(taskId) },
      },
    ]);
    await recoverCloudWorkflow(ctx.deps, taskId);
    expect(ctx.calls.filter((call) => call.method === 'POST')).toHaveLength(1);
  });
  it('paginates execution lookup before deciding to create', async () => {
    const ctx = setup();
    vi.mocked(ctx.deps.transport.request)
      .mockResolvedValueOnce({ executions: [], nextPageToken: 'page-2' })
      .mockResolvedValueOnce({
        executions: [
          { name: executionName, state: 'ACTIVE', labels: { task: cloudTaskLabel(taskId) } },
        ],
      });
    await recoverCloudWorkflow(ctx.deps, taskId);
    expect(ctx.calls).toEqual([]); // overridden mock does not call the recording fake
    expect(ctx.deps.transport.request).toHaveBeenLastCalledWith({
      method: 'GET',
      url: `${base}${workflowName}/executions?pageSize=100&view=FULL&pageToken=page-2`,
    });
  });
  it.each([
    null,
    { executions: 'invalid' },
    { executions: [{ name: 'https://attacker.example', state: 'ACTIVE' }] },
    { nextPageToken: 123 },
  ])('fails closed on malformed execution response %j', async (response) => {
    const ctx = setup();
    vi.mocked(ctx.deps.transport.request).mockResolvedValueOnce(response);
    await expect(recoverCloudWorkflow(ctx.deps, taskId)).rejects.toThrow();
    expect(ctx.deps.transport.request).toHaveBeenCalledTimes(1);
  });
  it('rejects a repeated execution page token', async () => {
    const ctx = setup();
    vi.mocked(ctx.deps.transport.request).mockResolvedValue({
      executions: [],
      nextPageToken: 'same',
    });
    await expect(recoverCloudWorkflow(ctx.deps, taskId)).rejects.toThrow('pagination');
    expect(ctx.deps.transport.request).toHaveBeenCalledTimes(2);
  });
  it('rejects callback names that point outside the matching execution', async () => {
    const ctx = setup();
    ctx.active();
    vi.mocked(ctx.deps.transport.request)
      .mockResolvedValueOnce({
        executions: [
          { name: executionName, state: 'ACTIVE', labels: { task: cloudTaskLabel(taskId) } },
        ],
      })
      .mockResolvedValueOnce({
        callbacks: [{ name: `${workflowName}/executions/other/callback/c1`, method: 'POST' }],
      });
    await expect(ctx.port.signal(resume)).rejects.toThrow('callback resource');
    expect(ctx.deps.transport.request).toHaveBeenCalledTimes(2);
  });
});

describe('ledger-authoritative broker ticks and external receipts', () => {
  it.each(['PAUSED', 'CREATED', 'AUTHORIZED'] as const)(
    'leaves %s ticks unchanged with pending steps, completed receipts, or no steps',
    async (status) => {
      for (const progress of ['pending', 'receipted', 'empty'] as const) {
        const initial = task(status);
        const ctx = setup(initial);
        const external = externalStep();
        if (progress === 'receipted')
          await ctx.worker.log.put(taskId, external.step.id, 'draft:external-1');
        const checkpointSave = vi.spyOn(ctx.checkpoints, 'save');
        const logPut = vi.spyOn(ctx.worker.log, 'put');
        const logBump = vi.spyOn(ctx.worker.log, 'bump');
        const deps = { ...ctx.worker, steps: progress === 'empty' ? [] : [external.step] };
        expect(await advanceCloudWorkflow(deps, taskId)).toEqual({ action: 'wait', taskId });
        expect(await advanceCloudWorkflow(deps, taskId)).toEqual({ action: 'wait', taskId });
        expect(ctx.current()).toEqual(initial);
        expect(ctx.commit).not.toHaveBeenCalled();
        expect(checkpointSave).not.toHaveBeenCalled();
        expect(logPut).not.toHaveBeenCalled();
        expect(logBump).not.toHaveBeenCalled();
        expect(external.step.reconcile).not.toHaveBeenCalled();
        expect(external.step.authorize).not.toHaveBeenCalled();
        expect(external.step.execute).not.toHaveBeenCalled();
      }
    },
  );
  it('requires an explicit ledger resume before a paused task advances', async () => {
    const ctx = setup(task('PAUSED'));
    const external = externalStep();
    const deps = { ...ctx.worker, steps: [external.step] };
    await ctx.port.signal(resume);
    expect(await advanceCloudWorkflow(deps, taskId)).toEqual({ action: 'wait', taskId });
    expect(ctx.commit).not.toHaveBeenCalled();
    await ctx.commit(ctx.current(), { status: 'RUNNING', stepId: 'resume' });
    expect(await advanceCloudWorkflow(deps, taskId)).toEqual({ action: 'continue', taskId });
    expect(external.writes()).toBe(1);
  });
  it.each(['allow', 'wait', 'deny'] as const)(
    'preserves a pause arriving during %s authorization before any status change',
    async (verdict) => {
      const ctx = setup();
      const external = externalStep();
      vi.mocked(external.step.authorize).mockImplementation(() => {
        ctx.replace(transition(ctx.current(), 'PAUSED'));
        return Promise.resolve(verdict);
      });
      expect(await advanceCloudWorkflow({ ...ctx.worker, steps: [external.step] }, taskId)).toEqual(
        {
          action: 'wait',
          taskId,
        },
      );
      expect(ctx.current().status).toBe('PAUSED');
      expect(ctx.commit).not.toHaveBeenCalled();
      expect(external.step.execute).not.toHaveBeenCalled();
    },
  );
  it('preserves a pause arriving before completion from persisted receipts', async () => {
    const ctx = setup();
    const external = externalStep();
    await ctx.worker.log.put(taskId, external.step.id, 'draft:external-1');
    vi.spyOn(ctx.worker.log, 'list').mockImplementation(() => {
      ctx.replace(transition(ctx.current(), 'PAUSED'));
      return Promise.resolve([{ stepId: external.step.id, body: 'draft:external-1' }]);
    });
    expect(await advanceCloudWorkflow({ ...ctx.worker, steps: [external.step] }, taskId)).toEqual({
      action: 'wait',
      taskId,
    });
    expect(ctx.current().status).toBe('PAUSED');
    expect(ctx.commit).not.toHaveBeenCalled();
  });
  it('preserves a pause arriving during a failed external attempt', async () => {
    const ctx = setup();
    const external = externalStep();
    vi.mocked(external.step.execute).mockImplementation(() => {
      ctx.replace(transition(ctx.current(), 'PAUSED'));
      return Promise.reject(new Error('write rejected'));
    });
    expect(await advanceCloudWorkflow({ ...ctx.worker, steps: [external.step] }, taskId)).toEqual({
      action: 'wait',
      taskId,
    });
    expect(ctx.current().status).toBe('PAUSED');
    expect(ctx.commit).not.toHaveBeenCalled();
    expect(await ctx.worker.log.list(taskId)).toEqual([]);
  });
  it.each(['CREATED', 'AUTHORIZED'] as const)(
    'does not dispatch %s through recovery, checkpoint save, or a wake-up signal',
    async (status) => {
      const initial = task(status);
      const ctx = setup(initial);
      await recoverCloudWorkflow(ctx.deps, taskId);
      await ctx.port.save({ taskId, status, stepId: 'write-draft' });
      await ctx.port.signal(resume);
      expect(ctx.calls.filter((call) => call.method === 'POST')).toEqual([]);
      expect(ctx.current()).toEqual(initial);
      expect(ctx.commit).not.toHaveBeenCalled();
    },
  );
  it.each([
    'QUEUED',
    'RUNNING',
    'RETRYING',
    'WAITING_APPROVAL',
    'WAITING_INPUT',
    'BLOCKED_AUTH',
    'PAUSED',
  ] as const)('recovers an execution for dispatch-eligible ledger status %s', async (status) => {
    const ctx = setup(task(status));
    await recoverCloudWorkflow(ctx.deps, taskId);
    expect(ctx.calls.filter((call) => call.method === 'POST')).toHaveLength(1);
  });
  it('writes once and completes from ledger and receipts', async () => {
    const ctx = setup();
    const external = externalStep();
    const deps = { ...ctx.worker, steps: [external.step] };
    expect(await advanceCloudWorkflow(deps, taskId)).toEqual({ action: 'continue', taskId });
    expect(await advanceCloudWorkflow(deps, taskId)).toEqual({ action: 'done', taskId });
    expect(await advanceCloudWorkflow(deps, taskId)).toEqual({ action: 'done', taskId });
    expect(external.writes()).toBe(1);
    expect(ctx.current().status).toBe('COMPLETED');
    expect(ctx.events).toEqual(fixture('successful-ledger-events'));
  });
  it('waits for approval and rechecks fresh authorization when awakened', async () => {
    const ctx = setup();
    const external = externalStep();
    vi.mocked(external.step.authorize).mockResolvedValueOnce('wait').mockResolvedValueOnce('allow');
    const deps = { ...ctx.worker, steps: [external.step] };
    expect(await advanceCloudWorkflow(deps, taskId)).toEqual({ action: 'wait', taskId });
    expect(ctx.current().status).toBe('WAITING_APPROVAL');
    expect(external.writes()).toBe(0);
    expect(await advanceCloudWorkflow(deps, taskId)).toEqual({ action: 'continue', taskId });
    expect(external.writes()).toBe(1);
    expect(external.step.authorize).toHaveBeenCalledTimes(2);
  });
  it('blocks expired execution authorization without calling the tool', async () => {
    const ctx = setup();
    const external = externalStep();
    vi.mocked(external.step.authorize).mockResolvedValue('deny');
    expect(await advanceCloudWorkflow({ ...ctx.worker, steps: [external.step] }, taskId)).toEqual({
      action: 'wait',
      taskId,
    });
    expect(ctx.current().status).toBe('BLOCKED_AUTH');
    expect(ctx.events).toEqual(fixture('expired-authorization-ledger-events'));
    expect(external.step.execute).not.toHaveBeenCalled();
  });
  it('recovers a receipt after the worker died between external write and ledger commit', async () => {
    const ctx = setup();
    const external = externalStep();
    const deps = { ...ctx.worker, steps: [external.step] };
    vi.mocked(ctx.commit).mockRejectedValueOnce(new Error('worker killed'));
    await expect(advanceCloudWorkflow(deps, taskId)).rejects.toThrow('killed');
    expect(external.writes()).toBe(1);
    expect(await ctx.worker.log.list(taskId)).toEqual([]);
    expect(await advanceCloudWorkflow(deps, taskId)).toEqual({ action: 'continue', taskId });
    expect(external.writes()).toBe(1);
    expect(await ctx.worker.log.list(taskId)).toEqual([
      { stepId: 'write-draft', body: 'draft:external-1' },
    ]);
    expect(ctx.events).toEqual(fixture('recovered-ledger-events'));
  });
  it('recovers a lost tool response without another external write', async () => {
    const ctx = setup();
    const external = externalStep();
    const original = external.step.execute;
    external.step.execute = vi.fn<CloudStep['execute']>(async (input) => {
      await original(input);
      throw new Error('lost response');
    });
    const deps = { ...ctx.worker, steps: [external.step] };
    expect(await advanceCloudWorkflow(deps, taskId)).toEqual({ action: 'continue', taskId });
    expect(external.writes()).toBe(1);
    expect(ctx.events).toEqual(fixture('recovered-ledger-events'));
  });
  it('does not write when external outcome is unknown before execution', async () => {
    const ctx = setup();
    const external = externalStep();
    vi.mocked(external.step.reconcile).mockResolvedValue({ kind: 'unknown' });
    expect(await advanceCloudWorkflow({ ...ctx.worker, steps: [external.step] }, taskId)).toEqual({
      action: 'wait',
      taskId,
    });
    expect(external.step.authorize).not.toHaveBeenCalled();
    expect(external.writes()).toBe(0);
    expect(ctx.events).toEqual([]);
  });
  it('does not retry a write when a failed response cannot be reconciled', async () => {
    const ctx = setup();
    const external = externalStep();
    vi.mocked(external.step.execute).mockRejectedValue(new Error('timeout'));
    vi.mocked(external.step.reconcile)
      .mockResolvedValueOnce({ kind: 'absent' })
      .mockResolvedValue({ kind: 'unknown' });
    const deps = { ...ctx.worker, steps: [external.step] };
    expect(await advanceCloudWorkflow(deps, taskId)).toEqual({ action: 'wait', taskId });
    expect(await advanceCloudWorkflow(deps, taskId)).toEqual({ action: 'wait', taskId });
    expect(external.step.execute).toHaveBeenCalledTimes(1);
  });
  it('retries bounded failures only after authoritative absence is established', async () => {
    const ctx = setup();
    const external = externalStep();
    vi.mocked(external.step.execute).mockRejectedValue(new Error('rejected before write'));
    const deps = { ...ctx.worker, steps: [external.step], maxAttempts: 2 };
    expect(await advanceCloudWorkflow(deps, taskId)).toEqual({ action: 'continue', taskId });
    expect(ctx.current().status).toBe('RETRYING');
    expect(await advanceCloudWorkflow(deps, taskId)).toEqual({ action: 'done', taskId });
    expect(ctx.current().status).toBe('FAILED');
    expect(external.step.execute).toHaveBeenCalledTimes(2);
    expect(external.writes()).toBe(0);
  });
  it('preserves attempt limits across broker instance replacement', async () => {
    const ctx = setup();
    const external = externalStep();
    vi.mocked(external.step.execute).mockRejectedValue(new Error('no write'));
    await ctx.worker.log.bump(taskId, external.step.id);
    await ctx.worker.log.bump(taskId, external.step.id);
    expect(
      await advanceCloudWorkflow({ ...ctx.worker, steps: [external.step], maxAttempts: 2 }, taskId),
    ).toEqual({ action: 'done', taskId });
    expect(external.step.execute).not.toHaveBeenCalled();
    expect(ctx.current().status).toBe('FAILED');
  });
  it('preserves a receipt when cancellation wins while an external write is in flight', async () => {
    const ctx = setup();
    const external = externalStep();
    const original = external.step.execute;
    external.step.execute = vi.fn<CloudStep['execute']>(async (input) => {
      const receipt = await original(input);
      ctx.replace(transition(ctx.current(), 'CANCELLED'));
      return receipt;
    });
    const deps = { ...ctx.worker, steps: [external.step] };
    expect(await advanceCloudWorkflow(deps, taskId)).toEqual({ action: 'done', taskId });
    expect(ctx.current().status).toBe('CANCELLED');
    expect(ctx.events).toEqual(fixture('cancel-mid-write-ledger-events'));
    expect(external.writes()).toBe(1);
    expect(await advanceCloudWorkflow(deps, taskId)).toEqual({ action: 'done', taskId });
    expect(external.writes()).toBe(1);
  });
  it('rechecks cancellation that arrived during authorization before writing', async () => {
    const ctx = setup();
    const external = externalStep();
    external.step.authorize = vi.fn<CloudStep['authorize']>(() => {
      ctx.replace(transition(ctx.current(), 'CANCELLED'));
      return Promise.resolve('allow');
    });
    expect(await advanceCloudWorkflow({ ...ctx.worker, steps: [external.step] }, taskId)).toEqual({
      action: 'done',
      taskId,
    });
    expect(external.writes()).toBe(0);
  });
  it.each(['COMPLETED', 'CANCELLED', 'FAILED'] as const)(
    'does no tool work for terminal ledger status %s',
    async (status) => {
      const ctx = setup(task(status));
      const external = externalStep();
      expect(await advanceCloudWorkflow({ ...ctx.worker, steps: [external.step] }, taskId)).toEqual(
        { action: 'done', taskId },
      );
      expect(external.step.reconcile).not.toHaveBeenCalled();
      expect(ctx.events).toEqual([]);
    },
  );
  it('uses persisted receipts to skip completed steps after replacement', async () => {
    const ctx = setup();
    const external = externalStep();
    await ctx.worker.log.put(taskId, external.step.id, 'draft:external-1');
    expect(await advanceCloudWorkflow({ ...ctx.worker, steps: [external.step] }, taskId)).toEqual({
      action: 'done',
      taskId,
    });
    expect(external.step.execute).not.toHaveBeenCalled();
    expect(ctx.current().status).toBe('COMPLETED');
  });
  it('serializes two workers so only one external write occurs', async () => {
    const ctx = setup();
    const external = externalStep();
    const deps = { ...ctx.worker, steps: [external.step], withTaskLock: serialLock() };
    await Promise.all([advanceCloudWorkflow(deps, taskId), advanceCloudWorkflow(deps, taskId)]);
    expect(external.writes()).toBe(1);
    expect(ctx.current().status).toBe('COMPLETED');
  });
  it('uses stable payload-bound external keys without task metadata', () => {
    const external = externalStep();
    const first = cloudStepKey(taskId, external.step);
    expect(first).toMatch(/^[0-9a-f]{64}$/);
    expect(first).toBe(cloudStepKey(taskId, external.step));
    expect(first).not.toBe(cloudStepKey('other-task', external.step));
    expect(first).not.toBe(cloudStepKey(taskId, { ...external.step, payloadDigest: 'changed' }));
  });
});

describe('additional recovery boundaries', () => {
  it('repairs an outstanding receipt after cancellation and process death', async () => {
    const ctx = setup();
    const external = externalStep();
    const original = external.step.execute;
    external.step.execute = vi.fn<CloudStep['execute']>(async (input) => {
      const receipt = await original(input);
      ctx.replace(transition(ctx.current(), 'CANCELLED'));
      return receipt;
    });
    vi.mocked(ctx.commit).mockRejectedValueOnce(new Error('killed before receipt commit'));
    const deps = { ...ctx.worker, steps: [external.step] };
    await expect(advanceCloudWorkflow(deps, taskId)).rejects.toThrow('killed');
    expect(ctx.current().status).toBe('CANCELLED');
    expect(await ctx.worker.log.list(taskId)).toEqual([]);
    expect(await advanceCloudWorkflow(deps, taskId)).toEqual({ action: 'done', taskId });
    expect(ctx.events).toEqual(fixture('cancel-mid-write-ledger-events'));
    expect(external.writes()).toBe(1);
  });
  it('does not declare cancelled reconciliation complete while the external outcome is unknown', async () => {
    const ctx = setup(task('CANCELLED'));
    const external = externalStep();
    await ctx.checkpoints.save({ taskId, stepId: external.step.id, status: 'RUNNING' });
    vi.mocked(external.step.reconcile).mockResolvedValue({ kind: 'unknown' });
    expect(await advanceCloudWorkflow({ ...ctx.worker, steps: [external.step] }, taskId)).toEqual({
      action: 'wait',
      taskId,
    });
    expect(external.step.execute).not.toHaveBeenCalled();
    expect(ctx.current().status).toBe('CANCELLED');
  });
  it('moves from queued to running before writing', async () => {
    const ctx = setup(task('QUEUED'));
    const external = externalStep();
    expect(await advanceCloudWorkflow({ ...ctx.worker, steps: [external.step] }, taskId)).toEqual({
      action: 'continue',
      taskId,
    });
    expect(ctx.current().status).toBe('RUNNING');
    expect(ctx.events[0]).toEqual({ status: 'RUNNING', stepId: 'write-draft' });
    expect(external.writes()).toBe(1);
  });
  it('can block expired approval without violating waiting-state transitions', async () => {
    const ctx = setup(task('WAITING_APPROVAL'));
    const external = externalStep();
    vi.mocked(external.step.authorize).mockResolvedValue('deny');
    expect(await advanceCloudWorkflow({ ...ctx.worker, steps: [external.step] }, taskId)).toEqual({
      action: 'wait',
      taskId,
    });
    expect(ctx.current().status).toBe('BLOCKED_AUTH');
    expect(ctx.events.map((event) => event.status)).toEqual(['RUNNING', 'BLOCKED_AUTH']);
    expect(external.writes()).toBe(0);
  });
  it('recovers after receipt/outbox commit succeeded but workflow log persistence failed', async () => {
    const ctx = setup();
    const external = externalStep();
    const put = ctx.worker.log.put.bind(ctx.worker.log);
    const log = {
      ...ctx.worker.log,
      put: vi
        .fn<typeof put>()
        .mockRejectedValueOnce(new Error('log unavailable'))
        .mockImplementation(put),
    };
    const deps = { ...ctx.worker, log, steps: [external.step] };
    await expect(advanceCloudWorkflow(deps, taskId)).rejects.toThrow('log unavailable');
    expect(ctx.events).toEqual(fixture('recovered-ledger-events'));
    expect(await advanceCloudWorkflow(deps, taskId)).toEqual({ action: 'continue', taskId });
    expect(ctx.events).toEqual(fixture('recovered-ledger-events'));
    expect(external.writes()).toBe(1);
  });
  it('stops immediately if fresh authorization itself fails', async () => {
    const ctx = setup();
    const external = externalStep();
    vi.mocked(external.step.authorize).mockRejectedValue(new Error('policy service unavailable'));
    await expect(
      advanceCloudWorkflow({ ...ctx.worker, steps: [external.step] }, taskId),
    ).rejects.toThrow('unavailable');
    expect(external.writes()).toBe(0);
    expect(ctx.events).toEqual([]);
  });
  it('fails closed if reconciliation lookup fails', async () => {
    const ctx = setup();
    const external = externalStep();
    vi.mocked(external.step.reconcile).mockRejectedValue(new Error('lookup unavailable'));
    await expect(
      advanceCloudWorkflow({ ...ctx.worker, steps: [external.step] }, taskId),
    ).rejects.toThrow('unavailable');
    expect(external.writes()).toBe(0);
  });
  it.each([0, -1, 1.5, Number.NaN])(
    'rejects invalid durable attempt limit %s',
    async (maxAttempts) => {
      const ctx = setup();
      const external = externalStep();
      await expect(
        advanceCloudWorkflow({ ...ctx.worker, steps: [external.step], maxAttempts }, taskId),
      ).rejects.toThrow('attempt limit');
      expect(external.writes()).toBe(0);
    },
  );
  it('rejects duplicate step identities', async () => {
    const ctx = setup();
    const external = externalStep();
    await expect(
      advanceCloudWorkflow({ ...ctx.worker, steps: [external.step, external.step] }, taskId),
    ).rejects.toThrow('duplicate');
    expect(external.writes()).toBe(0);
  });
  it('rejects a noncanonical payload digest before calling cloud or tools', async () => {
    const ctx = setup();
    const external = externalStep();
    await expect(
      advanceCloudWorkflow(
        { ...ctx.worker, steps: [{ ...external.step, payloadDigest: 'invalid' }] },
        taskId,
      ),
    ).rejects.toThrow('identity');
    expect(external.writes()).toBe(0);
    expect(ctx.calls).toEqual([]);
  });
  it('repairs cancellation dispatch after a failure between signal record and ledger commit', async () => {
    const ctx = setup();
    ctx.active();
    vi.mocked(ctx.deps.cancelInLedger).mockRejectedValueOnce(new Error('ledger unavailable'));
    await expect(ctx.port.signal(cancel)).rejects.toThrow('unavailable');
    expect(ctx.calls).toEqual([]);
    expect(await ctx.port.signal(cancel)).toBe('duplicate');
    expect(ctx.current().status).toBe('CANCELLED');
    expect(ctx.calls).toEqual(fixture('cancel-requests'));
  });
  it('rechecks expired authorization on duplicate resume rather than trusting a recorded signal', async () => {
    const ctx = setup();
    ctx.active();
    expect(await ctx.port.signal(resume)).toBe('recorded');
    ctx.calls.length = 0;
    vi.mocked(ctx.deps.authorizeResume).mockRejectedValueOnce(new Error('authorization expired'));
    await expect(ctx.port.signal(resume)).rejects.toThrow('expired');
    expect(ctx.calls).toEqual(fixture('expired-authorization-requests'));
  });
  it('paginates active callbacks and uses singular resource names only for parsing', async () => {
    const ctx = setup();
    vi.mocked(ctx.deps.transport.request)
      .mockResolvedValueOnce({
        executions: [
          { name: executionName, state: 'ACTIVE', labels: { task: cloudTaskLabel(taskId) } },
        ],
      })
      .mockResolvedValueOnce({ callbacks: [], nextPageToken: 'callback-page-2' })
      .mockResolvedValueOnce({
        callbacks: [{ name: `${executionName}/callback/callback-1`, method: 'POST' }],
      })
      .mockResolvedValueOnce({});
    await ctx.port.signal(resume);
    expect(ctx.deps.transport.request).toHaveBeenNthCalledWith(3, {
      method: 'GET',
      url: `${base}${executionName}/callbacks?pageSize=100&pageToken=callback-page-2`,
    });
    expect(ctx.deps.transport.request).toHaveBeenLastCalledWith({
      method: 'POST',
      url: `${base}${executionName}/callbacks/callback-1`,
      body: { taskId, signalId: resume.signalId },
    });
  });
});
