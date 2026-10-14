import * as z from 'zod';

import { scheduleJson, scheduleRoute } from './schedules-auth.js';

import type { ScheduleRouteDeps } from './schedules-auth.js';
import type { Route } from '../http.js';
const lookup = z.strictObject({ id: z.uuid() });
export function schedulesRunRoutes(deps: ScheduleRouteDeps): Record<string, Route> {
  return {
    'POST /v1/schedules/runs': scheduleRoute(deps, async (subject, request) => {
      const parsed = lookup.safeParse(scheduleJson(request.body));
      if (!parsed.success) return { status: 400, body: { error: 'invalid_request' } };
      if ((await deps.store.read(subject, parsed.data.id)) === undefined)
        return { status: 404, body: { error: 'not_found' } };
      return { status: 200, body: { runs: await deps.store.runs(parsed.data.id) } };
    }),
  };
}
