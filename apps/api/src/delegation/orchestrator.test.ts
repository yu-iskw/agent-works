import { describe, expect, it, vi } from 'vitest';

import { BudgetExceeded } from '../finops/budget-guard.js';
import { createMemoryBudgetPort } from '../finops/memory-budget.js';
import { createMemoryDelegationPort } from '../ports/memory/delegation.js';

import { DelegationDenied } from './errors.js';
import {
  fixtureChild,
  fixtureContext,
  fixtureLimits,
  fixtureNow,
  fixtureOutput,
} from './fixtures.js';
import { createDelegator } from './orchestrator.js';
function world(flag: string | undefined = 'enabled') {
  const records = createMemoryDelegationPort();
  const budget = createMemoryBudgetPort();
  const execute = vi.fn(() => Promise.resolve(fixtureOutput));
  const verify = vi.fn(() => Promise.resolve({ accepted: true, verifierRef: 'independent-v1' }));
  const options = {
    flag,
    maxDepth: 2,
    records,
    budget,
    budgetPolicy: {
      task: fixtureLimits,
      user: fixtureLimits,
      mode: 'isolated-test-enforce' as const,
    },
    execute,
    verifier: { verify },
    now: () => fixtureNow,
  };
  return { records, budget, execute, verify, options, delegator: createDelegator(options) };
}
describe('delegation acceptance', () => {
  it('makes flag-off execution, verification, budget and edges unreachable', async () => {
    const w = world('disabled');
    await expect(w.delegator.spawn(fixtureContext, fixtureChild)).rejects.toThrow('disabled');
    expect(w.execute).not.toHaveBeenCalled();
    expect(w.verify).not.toHaveBeenCalled();
    expect(await w.budget.events()).toEqual([]);
    expect(await w.records.children('parent')).toEqual([]);
    expect(await w.records.audits('parent')).toMatchObject([{ reason: 'disabled' }]);
  });
  it('consumes only independently verified output and records its digest', async () => {
    const w = world();
    await expect(w.delegator.spawn(fixtureContext, fixtureChild)).resolves.toEqual(fixtureOutput);
    expect(w.verify).toHaveBeenCalledOnce();
    expect(await w.records.read('child-1')).toMatchObject({
      state: 'verified',
      verifierRef: 'independent-v1',
      depth: 1,
      traceId: 'trace-1',
    });
    expect(w.execute.mock.calls[0]).toBeDefined();
  });
  it('charges children to the parent envelope, with no independent child allowance', async () => {
    const w = world();
    const parent = {
      ...fixtureContext,
      budgetShare: { ...fixtureLimits, estimatedCostMicros: 200 },
    };
    await w.delegator.spawn(parent, fixtureChild);
    await expect(
      w.delegator.spawn(parent, { ...fixtureChild, childTaskId: 'child-2' }),
    ).rejects.toBeInstanceOf(BudgetExceeded);
    expect(w.execute).toHaveBeenCalledOnce();
    expect((await w.budget.events()).filter((row) => row.kind === 'charged')).toMatchObject([
      { scope: { taskId: 'parent' }, estimatedCostMicros: 60, inferenceSteps: 1 },
    ]);
  });
  it('does not return or consume a failed verification result', async () => {
    const w = world();
    w.verify.mockResolvedValue({ accepted: false, verifierRef: 'independent-v1' });
    const consume = vi.fn();
    await expect(
      w.delegator.spawn(fixtureContext, fixtureChild).then(consume),
    ).rejects.toBeInstanceOf(DelegationDenied);
    expect(consume).not.toHaveBeenCalled();
    expect(await w.records.read('child-1')).toMatchObject({ state: 'rejected' });
    expect(await w.records.audits('parent')).toMatchObject([{ reason: 'verification_failed' }]);
  });
  it('fails closed when verifier throws and preserves charged spend', async () => {
    const w = world();
    w.verify.mockRejectedValue(new Error('offline verifier unavailable'));
    await expect(w.delegator.spawn(fixtureContext, fixtureChild)).rejects.toThrow(
      'verification_failed',
    );
    expect((await w.budget.events()).filter((row) => row.kind === 'charged')).toHaveLength(1);
    expect(await w.records.read('child-1')).toMatchObject({ state: 'rejected', verifierRef: null });
  });
  it('denies duplicate concurrent child dispatch', async () => {
    const w = world();
    const outcomes = await Promise.allSettled([
      w.delegator.spawn(fixtureContext, fixtureChild),
      w.delegator.spawn(fixtureContext, fixtureChild),
    ]);
    expect(outcomes.map((row) => row.status)).toEqual(['fulfilled', 'rejected']);
    expect(w.execute).toHaveBeenCalledOnce();
  });
  it('grants only one execution owner across two orchestrator instances', async () => {
    const w = world();
    const outcomes = await Promise.allSettled([
      createDelegator(w.options).spawn(fixtureContext, fixtureChild),
      createDelegator(w.options).spawn(fixtureContext, fixtureChild),
    ]);
    expect(outcomes.filter((row) => row.status === 'fulfilled')).toHaveLength(1);
    expect(outcomes.filter((row) => row.status === 'rejected')).toHaveLength(1);
    expect(w.execute).toHaveBeenCalledOnce();
    expect(w.verify).toHaveBeenCalledOnce();
  });
  it.each(['estimatedCostMicros', 'inferenceSteps', 'parallelism'] as const)(
    'enforces cumulative immediate-parent %s allocations independently of the root envelope',
    async (dimension) => {
      const w = world();
      const share = {
        ...fixtureLimits,
        estimatedCostMicros: 0,
        inferenceSteps: 0,
        parallelism: 0,
        [dimension]: 30,
      };
      const parent = {
        ...fixtureContext,
        taskId: 'nested-parent',
        rootTaskId: 'parent',
        depth: 1,
        budgetShare: share,
      };
      const child = { ...fixtureChild, budgetShare: share };
      w.options.budgetPolicy.task = { ...fixtureLimits, [dimension]: 100 };
      w.options.budgetPolicy.user = { ...fixtureLimits, [dimension]: 100 };
      const delegator = createDelegator(w.options);
      await delegator.spawn(parent, child);
      await expect(
        createDelegator(w.options).spawn(parent, { ...child, childTaskId: 'child-2' }),
      ).rejects.toThrow('budget_share');
      expect(w.execute).toHaveBeenCalledOnce();
      expect(await w.records.read('child-2')).toBeUndefined();
    },
  );
  it('does not re-execute a persisted child after orchestrator reconstruction', async () => {
    const w = world();
    await w.delegator.spawn(fixtureContext, fixtureChild);
    await expect(createDelegator(w.options).spawn(fixtureContext, fixtureChild)).rejects.toThrow(
      'identity',
    );
    expect(w.execute).toHaveBeenCalledOnce();
  });
  it('enforces depth before dispatch or charging', async () => {
    const w = world();
    await expect(w.delegator.spawn({ ...fixtureContext, depth: 2 }, fixtureChild)).rejects.toThrow(
      'depth',
    );
    expect(w.execute).not.toHaveBeenCalled();
    expect(await w.budget.events()).toEqual([]);
    expect(await w.records.audits('parent')).toMatchObject([{ reason: 'depth' }]);
  });
  it('settles child execution failure without allowing consumption', async () => {
    const w = world();
    w.execute.mockRejectedValue(new Error('offline failure'));
    await expect(w.delegator.spawn(fixtureContext, fixtureChild)).rejects.toThrow(
      'offline failure',
    );
    expect(w.verify).not.toHaveBeenCalled();
    expect(await w.records.read('child-1')).toMatchObject({ state: 'failed' });
    expect((await w.budget.events()).filter((row) => row.kind === 'released')).toHaveLength(1);
  });
});

it('keeps delegation unreachable when the operator flag is omitted', async () => {
  const w = world();
  const options = { ...w.options, flag: undefined };
  await expect(createDelegator(options).spawn(fixtureContext, fixtureChild)).rejects.toThrow(
    'disabled',
  );
  expect(w.execute).not.toHaveBeenCalled();
  expect(w.verify).not.toHaveBeenCalled();
  expect(await w.budget.events()).toEqual([]);
  expect(await w.records.children('parent')).toEqual([]);
});
