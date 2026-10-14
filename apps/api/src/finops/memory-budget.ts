import { addUsage, emptyUsage } from '@agent-works/domain/budget';

import { admission, admissionEvent } from './budget-admission.js';
import { chargeFingerprint, userBudgetKey, validateCharge } from './budget-validation.js';

import type { BudgetEvent, BudgetPort, Reservation } from './budget-port.js';
import type { BudgetUsage } from '@agent-works/domain/budget';

/** A synchronous critical section before returning promises; shared by every guard using this port. */
export function createMemoryBudgetPort(): BudgetPort {
  const tasks = new Map<string, BudgetUsage>();
  const users = new Map<string, BudgetUsage>();
  const scopes = new Map<string, string>();
  const reservations = new Map<string, Reservation>();
  const released = new Set<string>();
  const evidence: BudgetEvent[] = [];
  return {
    reserve(charge, policy) {
      validateCharge(charge, policy);
      const existing = reservations.get(charge.operationId);
      if (existing !== undefined) {
        if (chargeFingerprint(existing.charge) !== chargeFingerprint(charge))
          throw new Error('budget operation identity conflict');
        return Promise.resolve(structuredClone(existing));
      }
      const userKey = userBudgetKey(charge);
      const scope = JSON.stringify([userKey, charge.scope.sponsor]);
      const previousScope = scopes.get(charge.scope.taskId);
      if (previousScope !== undefined && previousScope !== scope)
        throw new Error('budget task scope conflict');
      const taskUsage = addUsage(tasks.get(charge.scope.taskId) ?? emptyUsage(), charge);
      const userUsage = addUsage(users.get(userKey) ?? emptyUsage(), charge);
      const reservation = structuredClone(admission(charge, policy, taskUsage, userUsage));
      const { allowed } = reservation;
      reservations.set(charge.operationId, reservation);
      scopes.set(charge.scope.taskId, scope);
      if (allowed) {
        tasks.set(charge.scope.taskId, taskUsage);
        users.set(userKey, userUsage);
      }
      evidence.push(admissionEvent(reservation, policy));
      return Promise.resolve(structuredClone(reservation));
    },
    release(operationId) {
      const reservation = reservations.get(operationId);
      if (reservation === undefined) throw new Error('unknown budget operation');
      if (released.has(operationId) || !reservation.allowed) return Promise.resolve();
      released.add(operationId);
      const { charge } = reservation;
      const task = tasks.get(charge.scope.taskId);
      const userKey = userBudgetKey(charge);
      const user = users.get(userKey);
      if (task === undefined || user === undefined) throw new Error('budget state');
      tasks.set(charge.scope.taskId, {
        ...task,
        parallelism: task.parallelism - charge.parallelism,
      });
      users.set(userKey, { ...user, parallelism: user.parallelism - charge.parallelism });
      evidence.push({
        eventId: `release:${operationId}`,
        operationId,
        scope: charge.scope,
        kind: 'released',
        dimension: null,
        estimatedCostMicros: 0,
        inferenceSteps: 0,
        mode: evidence.find((event) => event.operationId === operationId)?.mode ?? 'observe',
      });
      return Promise.resolve();
    },
    events() {
      return Promise.resolve(structuredClone(evidence));
    },
  };
}
