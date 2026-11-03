import { handoff, recordRejected } from './store.js';

import type { WorkerBudget } from './types.js';
import type { DeliveryStore } from '../queue/worker-delivery.js';
import type postgres from 'postgres';

/** The SCH-03 `DeliveryStore` over Postgres. Wiring mounts this behind `createDeliveryHandler`. */
export function createPostgresDeliveryStore(
  sql: postgres.Sql,
  options: { readonly budget: WorkerBudget; readonly now?: () => Date },
): DeliveryStore {
  const now = options.now ?? (() => new Date());
  return {
    handoff: ({ envelope }) =>
      handoff(sql, {
        executionId: envelope.executionId,
        now: now().toISOString(),
        budget: options.budget,
      }),
    recordRejected: ({ reason, caller }) => recordRejected(sql, { reason, callerSub: caller.sub }),
  };
}
