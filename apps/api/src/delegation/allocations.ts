import type { BudgetLimits } from '@agent-works/domain/budget';
import type { DelegationEdge } from '@agent-works/domain/delegation';

/** Allocations remain reserved after settlement: siblings share a finite parent allowance. */
export function allocationFits(
  children: readonly DelegationEdge[],
  requested: BudgetLimits,
  parentShare: BudgetLimits,
): boolean {
  const allocated = children.reduce(
    (total, child) => ({
      estimatedCostMicros: total.estimatedCostMicros + child.budgetShare.estimatedCostMicros,
      inferenceSteps: total.inferenceSteps + child.budgetShare.inferenceSteps,
      parallelism: total.parallelism + child.budgetShare.parallelism,
    }),
    { estimatedCostMicros: 0, inferenceSteps: 0, parallelism: 0 },
  );
  return (
    allocated.estimatedCostMicros + requested.estimatedCostMicros <=
      parentShare.estimatedCostMicros &&
    allocated.inferenceSteps + requested.inferenceSteps <= parentShare.inferenceSteps &&
    allocated.parallelism + requested.parallelism <= parentShare.parallelism
  );
}
