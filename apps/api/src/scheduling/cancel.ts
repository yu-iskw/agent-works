import { createTaskRoutes } from '../routes/tasks.js';

import type { Caller } from '../auth/iap.js';
import type { LedgerPort } from '../ports/ledger-port.js';
export type ScheduleCancel = (subject: string, taskId: string, key: string) => Promise<void>;
/** Uses the same control-plane cancellation path as POST /v1/tasks/:id:cancel. */
export function createScheduleCancel(ledger: LedgerPort): ScheduleCancel {
  return async (subject, taskId, key) => {
    const route = createTaskRoutes(ledger, () =>
      Promise.resolve({ sub: subject, assertion: 'local-scheduler' } as Caller),
    ).cancel;
    if (route === undefined) throw new Error('cancel unavailable');
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const result = await route({
        method: 'POST',
        path: `/v1/tasks/${taskId}:cancel`,
        headers: { 'idempotency-key': key },
        body: Buffer.alloc(0),
      });
      if (result.status === 200) return;
      if (result.status !== 409) throw new Error('schedule cancel failed');
    }
    throw new Error('schedule cancel conflict');
  };
}
