import { afterEach, describe, expect, it, vi } from 'vitest';

import { acceptInput } from '../ports/dispatch-port.contract.js';
import { createMemoryTaskPorts } from '../ports/memory/task-ports.js';

import { createSkillRegistry } from './registry.js';
import { createTaskDispatcher } from './task-dispatcher.js';

import type { RegisteredSkill } from './incident.js';

function setup(dispatch: RegisteredSkill['dispatch']) {
  const ports = createMemoryTaskPorts();
  const registry = createSkillRegistry([
    {
      manifest: { id: 'ask', version: '1', state: 'PUBLISHED', tools: [] },
      validate: () => true,
      dispatch,
    },
  ]);
  return { ...ports, registry };
}

function deferred() {
  let resolve = () => {};
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

afterEach(() => {
  vi.useRealTimers();
});

describe('worker lifecycle', () => {
  it('renews leases throughout a slow delivery and stops its heartbeat afterwards', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-10T10:00:00.000Z'));
    const completion = deferred();
    const started = deferred();
    const ports = setup(() => {
      started.resolve();
      return completion.promise;
    });
    await ports.dispatch.accept(acceptInput);
    const renew = vi.spyOn(ports.dispatch, 'renew');
    const worker = createTaskDispatcher({ ...ports, leaseMs: 300 });
    const running = worker.runOnce();
    await started.promise;
    await vi.advanceTimersByTimeAsync(700);
    expect(renew).toHaveBeenCalledTimes(7);
    expect(await ports.dispatch.claim('contender', 300)).toBeUndefined();
    completion.resolve();
    await running;
    expect(vi.getTimerCount()).toBe(0);
  });

  it('aborts execution after renewal loses its fence and rejects late success', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-10T10:00:00.000Z'));
    const completion = deferred();
    const started = deferred();
    let signal: AbortSignal | undefined;
    const ports = setup((_request, _accepted, _authorized, execution) => {
      signal = execution?.signal;
      started.resolve();
      return completion.promise;
    });
    const accepted = await ports.dispatch.accept(acceptInput);
    const originalRenew = ports.dispatch.renew.bind(ports.dispatch);
    vi.spyOn(ports.dispatch, 'renew').mockImplementation(async (lease, ms) => {
      // Advance the durable clock without ticking the heartbeat, simulating a stalled process.
      vi.setSystemTime(new Date('2026-10-10T10:00:01.000Z'));
      await ports.dispatch.claim('reclaimer', 300);
      return originalRenew(lease, ms);
    });
    const running = createTaskDispatcher({ ...ports, leaseMs: 300 }).runOnce();
    await started.promise;
    await vi.advanceTimersByTimeAsync(100);
    expect(signal?.aborted).toBe(true);
    completion.resolve();
    await running;
    expect(await ports.ledger.read('alice', accepted.taskId)).toMatchObject({
      status: 'RUNNING',
      version: 2,
    });
    expect(await ports.ledger.readOutbox(`dispatch:${accepted.taskId}:3`)).toBeUndefined();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('starts once, drains an aborted delivery on shutdown, and resumes its persisted retry', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-10T10:00:00.000Z'));
    const started = deferred();
    const dispatch = vi
      .fn<RegisteredSkill['dispatch']>()
      .mockImplementation((_request, _accepted, _authorized, execution) => {
        started.resolve();
        return new Promise<void>((_resolve, reject) => {
          execution?.signal?.addEventListener(
            'abort',
            reject.bind(undefined, new Error('shutdown')),
            {
              once: true,
            },
          );
        });
      });
    const ports = setup(dispatch);
    const accepted = await ports.dispatch.accept(acceptInput);
    const worker = createTaskDispatcher({ ...ports, leaseMs: 300, retryMs: 100 });
    worker.start();
    worker.start();
    await started.promise;
    await worker.stop();
    expect(dispatch).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
    expect(await ports.ledger.read('alice', accepted.taskId)).toMatchObject({ status: 'RUNNING' });
    dispatch.mockResolvedValue();
    await vi.advanceTimersByTimeAsync(100);
    await createTaskDispatcher({ ...ports }).runOnce();
    expect(await ports.ledger.read('alice', accepted.taskId)).toMatchObject({
      status: 'COMPLETED',
      version: 3,
    });
    await worker.stop();
  });

  it.each([
    { kind: 'revoked' as const, status: 'BLOCKED_AUTH' },
    { kind: 'cancelled' as const, status: 'CANCELLED' },
    { kind: 'timeout' as const, status: 'FAILED' },
    { kind: 'failed' as const, status: 'FAILED' },
  ])('persists skill result $kind as $status', async ({ kind, status }) => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-10T10:00:00.000Z'));
    const dispatch = vi.fn<RegisteredSkill['dispatch']>().mockRejectedValue(new Error(kind));
    const ports = setup(dispatch);
    const accepted = await ports.dispatch.accept(acceptInput);
    const skill = ports.registry.get('ask');
    if (skill === undefined) throw new Error('skill');
    const registry = createSkillRegistry([Object.assign({}, skill, { result: () => ({ kind }) })]);
    await createTaskDispatcher({ ...ports, registry, maxAttempts: 1 }).runOnce();
    expect(await ports.ledger.read('alice', accepted.taskId)).toMatchObject({ status, version: 3 });
    expect(await ports.dispatch.claim('again', 1000)).toBeUndefined();
  });

  it('does not start delivery after its persisted deadline', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-10T10:06:00.000Z'));
    const dispatch = vi.fn<RegisteredSkill['dispatch']>().mockResolvedValue();
    const ports = setup(dispatch);
    const accepted = await ports.dispatch.accept(acceptInput);
    await createTaskDispatcher(ports).runOnce();
    expect(dispatch).not.toHaveBeenCalled();
    expect(await ports.ledger.read('alice', accepted.taskId)).toMatchObject({
      status: 'FAILED',
      version: 3,
    });
  });

  it.each([0, -1, 0.5])('rejects invalid lease configuration %s', (leaseMs) => {
    expect(() => createTaskDispatcher({ ...setup(() => Promise.resolve()), leaseMs })).toThrow(
      RangeError,
    );
  });
});
