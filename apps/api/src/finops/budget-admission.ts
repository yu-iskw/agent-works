import { exceededDimension } from '#domain-budget';

import type { BudgetCharge, BudgetUsage } from '#domain-budget';
import type { BudgetEvent, BudgetPolicy, Reservation } from './budget-port.js';

export function admission(
  charge: BudgetCharge,
  policy: BudgetPolicy,
  taskUsage: BudgetUsage,
  userUsage: BudgetUsage,
): Reservation {
  const exceeded =
    exceededDimension(taskUsage, policy.task) ?? exceededDimension(userUsage, policy.user) ?? null;
  return {
    charge,
    taskUsage,
    userUsage,
    exceeded,
    allowed: exceeded === null || policy.mode === 'observe',
  };
}
export function admissionEvent(reservation: Reservation, policy: BudgetPolicy): BudgetEvent {
  const { charge, exceeded, allowed } = reservation;
  return {
    eventId: `reserve:${charge.operationId}`,
    operationId: charge.operationId,
    scope: structuredClone(charge.scope),
    kind: exceeded === null ? 'charged' : 'exceeded',
    dimension: exceeded,
    estimatedCostMicros: allowed ? charge.estimatedCostMicros : 0,
    inferenceSteps: allowed ? charge.inferenceSteps : 0,
    mode: policy.mode,
  };
}
