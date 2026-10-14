import { ClassifiedError } from '#domain-error-class';

import type { BudgetCharge } from '#domain-budget';
import type { BudgetPolicy, BudgetPort, Reservation } from './budget-port.js';

export class BudgetExceeded extends ClassifiedError {
  constructor(readonly reservation: Reservation) {
    super('policy', 'budget_exceeded');
    this.name = 'BudgetExceeded';
  }
}
/** Default observe mode is binding for the dev project under ADR 0003. */
export function budgetGuard(port: BudgetPort, policy: BudgetPolicy) {
  return {
    async reserve(charge: BudgetCharge): Promise<Reservation> {
      const reservation = await port.reserve(charge, policy);
      if (!reservation.allowed) throw new BudgetExceeded(reservation);
      return reservation;
    },
    async run<T>(charge: BudgetCharge, operation: () => Promise<T>): Promise<T> {
      const reservation = await port.reserve(charge, policy);
      if (!reservation.allowed) throw new BudgetExceeded(reservation);
      try {
        return await operation();
      } finally {
        await port.release(charge.operationId);
      }
    },
  };
}
