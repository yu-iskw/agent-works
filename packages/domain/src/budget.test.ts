import { expect, it } from 'vitest';

import { addUsage, budgetLimitsSchema, emptyUsage, exceededDimension } from './budget.js';

it('uses exact integer units and catches overflow', () => {
  expect(
    addUsage(emptyUsage(), { estimatedCostMicros: 10, inferenceSteps: 1, parallelism: 2 }),
  ).toEqual({ estimatedCostMicros: 10, inferenceSteps: 1, parallelism: 2 });
  expect(() =>
    addUsage(
      { ...emptyUsage(), estimatedCostMicros: Number.MAX_SAFE_INTEGER },
      { ...emptyUsage(), estimatedCostMicros: 1 },
    ),
  ).toThrow();
});
it('requires the explicit placeholder marker', () => {
  expect(() =>
    budgetLimitsSchema.parse({ estimatedCostMicros: 10, inferenceSteps: 1, parallelism: 2 }),
  ).toThrow();
});
it('allows exactly the limit', () => {
  const limits = {
    approval: 'PLACEHOLDER' as const,
    estimatedCostMicros: 10,
    inferenceSteps: 2,
    parallelism: 1,
  };
  expect(exceededDimension(limits, limits)).toBeUndefined();
});
