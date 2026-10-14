import * as z from 'zod';

/** Every value supplied under this contract is an UNAPPROVED PLACEHOLDER. */
export const budgetLimitsSchema = z.strictObject({
  approval: z.literal('PLACEHOLDER'),
  estimatedCostMicros: z.number().int().nonnegative().safe(),
  inferenceSteps: z.number().int().nonnegative().safe(),
  parallelism: z.number().int().nonnegative().safe(),
});
export type BudgetLimits = z.infer<typeof budgetLimitsSchema>;
export type BudgetUsage = {
  readonly estimatedCostMicros: number;
  readonly inferenceSteps: number;
  readonly parallelism: number;
};
export type BudgetDimension = keyof BudgetUsage;
export type BudgetScope = {
  readonly taskId: string;
  readonly userSubject: string;
  readonly sponsor: string;
  readonly window: string;
};
export type BudgetCharge = {
  readonly operationId: string;
  readonly scope: BudgetScope;
  readonly estimatedCostMicros: number;
  readonly inferenceSteps: number;
  readonly parallelism: number;
};

export const budgetUsageSchema = z.strictObject({
  estimatedCostMicros: z.number().int().nonnegative().safe(),
  inferenceSteps: z.number().int().nonnegative().safe(),
  parallelism: z.number().int().nonnegative().safe(),
});
export function emptyUsage(): BudgetUsage {
  return { estimatedCostMicros: 0, inferenceSteps: 0, parallelism: 0 };
}
export function addUsage(left: BudgetUsage, right: BudgetUsage): BudgetUsage {
  return budgetUsageSchema.parse({
    estimatedCostMicros: left.estimatedCostMicros + right.estimatedCostMicros,
    inferenceSteps: left.inferenceSteps + right.inferenceSteps,
    parallelism: left.parallelism + right.parallelism,
  });
}
export function exceededDimension(
  usage: BudgetUsage,
  limits: BudgetLimits,
): BudgetDimension | undefined {
  if (usage.estimatedCostMicros > limits.estimatedCostMicros) return 'estimatedCostMicros';
  if (usage.inferenceSteps > limits.inferenceSteps) return 'inferenceSteps';
  if (usage.parallelism > limits.parallelism) return 'parallelism';
  return undefined;
}
