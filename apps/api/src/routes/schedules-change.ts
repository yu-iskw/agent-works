import * as z from 'zod';

import { scheduleJson, scheduleRoute } from './schedules-auth.js';

import type { ScheduleRouteDeps } from './schedules-auth.js';
import type { Route } from '../http.js';
const command = z.strictObject({
  id: z.uuid(),
  expectedRevision: z.number().int().positive(),
  action: z.enum(['pause', 'resume', 'revoke']),
});
export function schedulesChangeRoutes(deps: ScheduleRouteDeps): Record<string, Route> {
  return {
    'POST /v1/schedules/change': scheduleRoute(deps, async (subject, request) => {
      const parsed = command.safeParse(scheduleJson(request.body));
      if (!parsed.success) return { status: 400, body: { error: 'invalid_change' } };
      const row = await deps.store.read(subject, parsed.data.id);
      if (row === undefined) return { status: 404, body: { error: 'not_found' } };
      return {
        status: 200,
        body: await deps.scheduler.change(
          subject,
          parsed.data.id,
          parsed.data.expectedRevision,
          parsed.data.action,
        ),
      };
    }),
  };
}
