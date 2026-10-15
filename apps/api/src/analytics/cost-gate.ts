import { reject } from './errors.js';

import type { BudgetPolicy, BudgetPort } from '../finops/budget-port.js';
export type AnalyticsBudget = {
  port: BudgetPort;
  policy: BudgetPolicy;
  microsPerMillionBytes: number;
};
export async function costGate(
  bytes: number,
  maxBytes: number,
  budget: AnalyticsBudget,
  input: { queryId: string; subject: string; taskId: string; at: string },
): Promise<void> {
  if (!Number.isSafeInteger(bytes) || bytes < 0) reject('INVALID_ESTIMATE', 503);
  if (bytes > maxBytes) reject('BYTE_CAP_EXCEEDED', 422);
  if (!Number.isSafeInteger(budget.microsPerMillionBytes) || budget.microsPerMillionBytes < 0)
    reject('INVALID_COST_POLICY', 503);
  const estimatedCostMicros = Math.ceil((bytes / 1000000) * budget.microsPerMillionBytes);
  if (!Number.isSafeInteger(estimatedCostMicros)) reject('INVALID_ESTIMATE', 503);
  const reservation = await budget.port.reserve(
    {
      operationId: input.queryId,
      scope: {
        taskId: input.taskId,
        userSubject: input.subject,
        sponsor: input.subject,
        window: input.at.slice(0, 10),
      },
      estimatedCostMicros,
      inferenceSteps: 0,
      parallelism: 1,
    },
    // Analytics query admission uses enforce semantics: a denied query must never be charged.
    { ...budget.policy, mode: 'isolated-test-enforce' },
  );
  if (!reservation.allowed || reservation.exceeded !== null) {
    await budget.port.release(input.queryId);
    reject('BUDGET_EXCEEDED', 422);
  }
}
