import { describe, expect, it, vi } from 'vitest';

import { budgetGuard, BudgetExceeded } from './budget-guard.js';
import { createMemoryBudgetPort } from './memory-budget.js';
import { showback } from './showback.js';

import type { BudgetPolicy } from './budget-port.js';
import type { BudgetCharge } from '@agent-works/domain/budget';

const limits = {
  approval: 'PLACEHOLDER' as const,
  estimatedCostMicros: 100,
  inferenceSteps: 3,
  parallelism: 2,
};
const policy: BudgetPolicy = { task: limits, user: limits, mode: 'isolated-test-enforce' };
const charge: BudgetCharge = {
  operationId: 'op-1',
  scope: { taskId: 'task-1', userSubject: 'alice', sponsor: 'platform', window: 'fixture-window' },
  estimatedCostMicros: 10,
  inferenceSteps: 1,
  parallelism: 1,
};
function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}
describe('L3 guard and L6 showback', () => {
  it('deduplicates concurrent and settled executions across guards without freeing an active slot', async () => {
    const port = createMemoryBudgetPort();
    const singleSlot = { ...limits, parallelism: 1 };
    const enforced = { ...policy, task: singleSlot, user: singleSlot };
    const guard = budgetGuard(port, enforced);
    const anotherGuard = budgetGuard(port, enforced);
    const entered = deferred<void>();
    const finish = deferred<string>();
    const operation = vi.fn(() => {
      entered.resolve();
      return finish.promise;
    });
    const retryOperation = vi.fn().mockResolvedValue('retry');
    const first = guard.run(charge, operation);
    await entered.promise;
    const retry = anotherGuard.run(charge, retryOperation);
    try {
      await expect(
        guard.run({ ...charge, operationId: 'blocked' }, retryOperation),
      ).rejects.toBeInstanceOf(BudgetExceeded);
      expect(operation).toHaveBeenCalledTimes(1);
      expect(retryOperation).not.toHaveBeenCalled();
      expect((await port.events()).filter((event) => event.kind === 'released')).toHaveLength(0);
    } finally {
      finish.resolve('original');
      await Promise.all([first, retry]);
    }
    await expect(first).resolves.toBe('original');
    await expect(retry).resolves.toBe('original');
    await expect(anotherGuard.run(charge, retryOperation)).resolves.toBe('original');
    expect(retryOperation).not.toHaveBeenCalled();
    await expect(
      guard.run({ ...charge, operationId: 'after-release' }, () => Promise.resolve('next')),
    ).resolves.toBe('next');
    await expect(guard.run({ ...charge, estimatedCostMicros: 20 }, retryOperation)).rejects.toThrow(
      'identity conflict',
    );
  });
  it('retains a failed execution for idempotent retries', async () => {
    const guard = budgetGuard(createMemoryBudgetPort(), policy);
    const operation = vi.fn().mockRejectedValue(new Error('fixture'));
    await expect(guard.run(charge, operation)).rejects.toThrow('fixture');
    await expect(guard.run(charge, operation)).rejects.toThrow('fixture');
    expect(operation).toHaveBeenCalledTimes(1);
  });
  it.each([
    {
      estimatedCostMicros: 101,
      inferenceSteps: 1,
      parallelism: 1,
      dimension: 'estimatedCostMicros',
    },
    { estimatedCostMicros: 10, inferenceSteps: 4, parallelism: 1, dimension: 'inferenceSteps' },
    { estimatedCostMicros: 10, inferenceSteps: 1, parallelism: 3, dimension: 'parallelism' },
  ])('gives a controlled $dimension error and audit event', async (values) => {
    const port = createMemoryBudgetPort();
    const operation = vi.fn().mockResolvedValue('unsafe');
    const attempt = {
      ...charge,
      estimatedCostMicros: values.estimatedCostMicros,
      inferenceSteps: values.inferenceSteps,
      parallelism: values.parallelism,
    };
    await expect(budgetGuard(port, policy).run(attempt, operation)).rejects.toBeInstanceOf(
      BudgetExceeded,
    );
    expect(operation).not.toHaveBeenCalled();
    expect(await port.events()).toEqual([
      expect.objectContaining({
        kind: 'exceeded',
        dimension: values.dimension,
        estimatedCostMicros: 0,
      }),
    ]);
  });
  it('observes overruns without imposing a dev hard stop', async () => {
    const port = createMemoryBudgetPort();
    await expect(
      budgetGuard(port, { ...policy, mode: 'observe' }).run(
        { ...charge, estimatedCostMicros: 500 },
        () => Promise.resolve('ran'),
      ),
    ).resolves.toBe('ran');
    expect(await port.events()).toEqual([
      expect.objectContaining({ kind: 'exceeded', estimatedCostMicros: 500 }),
      expect.objectContaining({ kind: 'released' }),
    ]);
  });
  it('aggregates user usage across tasks atomically', async () => {
    const port = createMemoryBudgetPort();
    const guard = budgetGuard(port, policy);
    const results = await Promise.allSettled([
      guard.reserve({ ...charge, estimatedCostMicros: 70 }),
      guard.reserve({
        ...charge,
        operationId: 'op-2',
        scope: { ...charge.scope, taskId: 'task-2' },
        estimatedCostMicros: 70,
      }),
    ]);
    expect(results.map((result) => result.status)).toEqual(['fulfilled', 'rejected']);
    expect(showback(await port.events())[0].estimatedCostMicros).toBe(70);
  });
  it('releases only concurrency, even when an operation throws', async () => {
    const port = createMemoryBudgetPort();
    const guard = budgetGuard(port, policy);
    await expect(guard.run(charge, () => Promise.reject(new Error('fixture')))).rejects.toThrow(
      'fixture',
    );
    await port.release(charge.operationId);
    expect(await guard.reserve({ ...charge, operationId: 'op-2' })).toMatchObject({
      taskUsage: { estimatedCostMicros: 20, inferenceSteps: 2, parallelism: 1 },
    });
  });
  it('deduplicates charges but rejects altered operation and task identities', async () => {
    const port = createMemoryBudgetPort();
    await port.reserve(charge, policy);
    await port.reserve(charge, policy);
    expect(await port.events()).toHaveLength(1);
    expect(() => port.reserve({ ...charge, estimatedCostMicros: 20 }, policy)).toThrow(
      'identity conflict',
    );
    expect(() =>
      port.reserve(
        { ...charge, operationId: 'new', scope: { ...charge.scope, sponsor: 'changed' } },
        policy,
      ),
    ).toThrow('scope conflict');
  });
  it('showback reconciles exactly to event sums and is independent of event order', async () => {
    const port = createMemoryBudgetPort();
    await port.reserve(charge, policy);
    await port.reserve(
      {
        ...charge,
        operationId: 'second',
        scope: { ...charge.scope, taskId: 'second-task', sponsor: 'product' },
      },
      policy,
    );
    const events = await port.events();
    expect(showback([...events, ...events])).toEqual(showback([...events].reverse()));
    expect(showback(events).reduce((sum, row) => sum + row.estimatedCostMicros, 0)).toBe(
      events.reduce((sum, event) => sum + event.estimatedCostMicros, 0),
    );
  });
});
