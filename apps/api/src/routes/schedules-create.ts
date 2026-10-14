import { eventTriggerCreateSchema, scheduleSpecSchema, privilegeWithin } from '@agent-works/domain';

import { scheduleJson, scheduleRoute } from './schedules-auth.js';

import type { ScheduleRouteDeps } from './schedules-auth.js';
import type { Route } from '../http.js';
export function schedulesCreateRoutes(deps: ScheduleRouteDeps): Record<string, Route> {
  return {
    'POST /v1/schedules': scheduleRoute(deps, async (subject, request) => {
      const parsed = scheduleSpecSchema.safeParse(scheduleJson(request.body));
      if (!parsed.success) return { status: 400, body: { error: 'invalid_schedule' } };
      return { status: 201, body: await deps.scheduler.create(parsed.data, subject) };
    }),
    'POST /v1/schedules/preview': scheduleRoute(deps, async (subject, request) => {
      const parsed = scheduleSpecSchema.safeParse(scheduleJson(request.body));
      if (!parsed.success) return { status: 400, body: { error: 'invalid_schedule' } };
      if (parsed.data.sponsor.sub !== subject)
        return { status: 403, body: { error: 'SPONSOR_MISMATCH' } };
      const authority = await deps.authority(parsed.data);
      return {
        status: 200,
        body: {
          allowed:
            authority.active &&
            authority.subject === subject &&
            privilegeWithin(parsed.data.maxPrivilege, authority.privilege),
          maxPrivilege: parsed.data.maxPrivilege,
          authority: authority.privilege,
        },
      };
    }),
    'POST /v1/schedules/triggers': scheduleRoute(deps, async (subject, request) => {
      const parsed = eventTriggerCreateSchema.safeParse(scheduleJson(request.body));
      if (!parsed.success) return { status: 400, body: { error: 'invalid_trigger' } };
      return {
        status: 201,
        body: await deps.scheduler.create(parsed.data.schedule, subject, parsed.data.trigger),
      };
    }),
  };
}
