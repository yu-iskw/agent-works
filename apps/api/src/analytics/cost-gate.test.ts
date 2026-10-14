import { describe, expect, it, vi } from 'vitest';

import { createMemoryBudgetPort } from '../finops/memory-budget.js';

import { costGate } from './cost-gate.js';
import { analyticsAt, analyticsBudgetPolicy } from './fixtures.js';
const input = { queryId: 'query-147', subject: 'alice', taskId: 'task-147', at: analyticsAt };
describe('dry run admission and issue 137 budgets', () => {
  it('admits exactly at the byte cap', async () => {
    const port = createMemoryBudgetPort();
    await expect(
      costGate(
        1000,
        1000,
        { port, policy: analyticsBudgetPolicy, microsPerMillionBytes: 1000 },
        input,
      ),
    ).resolves.toBeUndefined();
    expect((await port.events())[0].estimatedCostMicros).toBe(1);
  });
  it('denies over byte cap without reserving', async () => {
    const port = createMemoryBudgetPort();
    const reserve = vi.spyOn(port, 'reserve');
    await expect(
      costGate(
        1001,
        1000,
        { port, policy: analyticsBudgetPolicy, microsPerMillionBytes: 1000 },
        input,
      ),
    ).rejects.toThrow('BYTE_CAP_EXCEEDED');
    expect(reserve).not.toHaveBeenCalled();
  });
  it.each(['observe', 'isolated-test-enforce'] as const)(
    'denies a local analytics budget in %s mode',
    async (mode) => {
      const port = createMemoryBudgetPort();
      const policy = {
        ...analyticsBudgetPolicy,
        mode,
        task: { ...analyticsBudgetPolicy.task, estimatedCostMicros: 0 },
      };
      await expect(
        costGate(1000, 1000, { port, policy, microsPerMillionBytes: 1000 }, input),
      ).rejects.toThrow('BUDGET_EXCEEDED');
      expect((await port.events())[0].dimension).toBe('estimatedCostMicros');
    },
  );
  it('rejects an invalid configured cost rate', async () => {
    await expect(
      costGate(
        1,
        100,
        {
          port: createMemoryBudgetPort(),
          policy: analyticsBudgetPolicy,
          microsPerMillionBytes: -1,
        },
        input,
      ),
    ).rejects.toThrow('INVALID_COST_POLICY');
  });
});
