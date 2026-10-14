import { budgetLimitsSchema, budgetUsageSchema } from '#domain-budget';

import type { BudgetCharge } from '#domain-budget';
import type { BudgetPolicy } from './budget-port.js';

export function validateCharge(charge: BudgetCharge, policy: BudgetPolicy): void {
  budgetUsageSchema.parse({
    estimatedCostMicros: charge.estimatedCostMicros,
    inferenceSteps: charge.inferenceSteps,
    parallelism: charge.parallelism,
  });
  budgetLimitsSchema.parse(policy.task);
  budgetLimitsSchema.parse(policy.user);
  if (!['observe', 'isolated-test-enforce'].includes(policy.mode)) throw new RangeError('mode');
  for (const value of [
    charge.operationId,
    charge.scope.taskId,
    charge.scope.userSubject,
    charge.scope.sponsor,
    charge.scope.window,
  ]) {
    if (value.length === 0 || value.length > 256) throw new RangeError('budget identity');
  }
}
export function chargeFingerprint(charge: BudgetCharge): string {
  return JSON.stringify([
    charge.operationId,
    charge.scope.taskId,
    charge.scope.userSubject,
    charge.scope.sponsor,
    charge.scope.window,
    charge.estimatedCostMicros,
    charge.inferenceSteps,
    charge.parallelism,
  ]);
}
export function userBudgetKey(charge: BudgetCharge): string {
  return JSON.stringify([charge.scope.userSubject, charge.scope.window]);
}
