import { scheduleRoute } from './schedules-auth.js';

import type { ScheduleRouteDeps } from './schedules-auth.js';
import type { Route } from '../http.js';
export function schedulesReadRoutes(deps: ScheduleRouteDeps): Record<string, Route> {
  return {
    'GET /v1/schedules': scheduleRoute(deps, async (subject) => ({
      status: 200,
      body: { schedules: await deps.store.list(subject) },
    })),
    'GET /v1/schedules/history': scheduleRoute(deps, async (subject) => ({
      status: 200,
      body: { events: await deps.store.history(subject) },
    })),
    'GET /v1/schedules/triggers': scheduleRoute(deps, async (subject) => ({
      status: 200,
      body: { triggers: await deps.store.triggers(subject) },
    })),
  };
}
