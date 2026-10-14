import { ClassifiedError } from '@agent-works/domain/error-class';

import type { BudgetPolicy, BudgetPort, Reservation } from './budget-port.js';
import type { BudgetCharge } from '@agent-works/domain/budget';

// Execution ownership is shared by guards using the same port. Retain settled
// results so an idempotent retry cannot execute after its slot was released.
const executions = new WeakMap<BudgetPort, Map<string, Promise<unknown>>>();

export class BudgetExceeded extends ClassifiedError {
  constructor(readonly reservation: Reservation) {
    super('policy', 'budget_exceeded');
    this.name = 'BudgetExceeded';
  }
}
/** Default observe mode is binding for the dev project under ADR 0003. */
export function budgetGuard(port: BudgetPort, policy: BudgetPolicy) {
  let owned = executions.get(port);
  if (owned === undefined) {
    owned = new Map();
    executions.set(port, owned);
  }
  const operations = owned;
  return {
    async reserve(charge: BudgetCharge): Promise<Reservation> {
      const reservation = await port.reserve(charge, policy);
      if (!reservation.allowed) throw new BudgetExceeded(reservation);
      return reservation;
    },
    async run<T>(charge: BudgetCharge, operation: () => Promise<T>): Promise<T> {
      const reservation = await port.reserve(charge, policy);
      if (!reservation.allowed) throw new BudgetExceeded(reservation);
      const existing = operations.get(charge.operationId);
      if (existing !== undefined) return (await existing) as T;
      const execution = Promise.resolve().then(async () => {
        try {
          return await operation();
        } finally {
          await port.release(charge.operationId);
        }
      });
      operations.set(charge.operationId, execution);
      return await execution;
    },
  };
}
