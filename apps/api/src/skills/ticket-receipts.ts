import { receiptFor } from './task-dispatcher.js';

import type { TaskDispatcherDeps } from './task-dispatcher.js';

/** A lookup failure must leave delivery retryable, including after its deadline. */
export function createTicketReconciler(
  ticketsUrl: string,
): NonNullable<TaskDispatcherDeps['reconcile']> {
  return async (delivery, signal) => {
    if (delivery.payload.request.skillId !== 'incident-analysis') return undefined;
    const response = await fetch(new URL('/tickets', ticketsUrl), {
      signal: AbortSignal.any([signal, AbortSignal.timeout(1000)]),
    });
    if (!response.ok) throw new Error('ticket receipt unavailable');
    const body: unknown = await response.json();
    if (!isRecord(body) || !Array.isArray(body.tickets)) throw new Error('ticket receipts invalid');
    for (const ticket of body.tickets as unknown[]) {
      if (!isRecord(ticket) || ticket.idempotencyKey !== delivery.taskId) continue;
      if (typeof ticket.id !== 'string' || ticket.id.length === 0)
        throw new Error('ticket receipt invalid');
      return receiptFor(delivery.taskId, ticket.id);
    }
    return undefined;
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
