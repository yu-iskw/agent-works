import { IAP_ASSERTION_HEADER } from '@agent-works/domain';

import { Unauthenticated } from '../auth/iap.js';
import { headerValue } from '../http.js';
import { ScheduleConflict } from '../ports/schedule-port.js';
import { ScheduleDenied } from '../scheduling/authority.js';

import type { VerifyAssertion } from '../auth/iap.js';
import type { Route } from '../http.js';
import type { SchedulePort } from '../ports/schedule-port.js';
import type { AuthorityResolver } from '../scheduling/authority.js';
import type { Scheduler } from '../scheduling/service.js';
export type ScheduleRouteDeps = {
  verify: VerifyAssertion;
  store: SchedulePort;
  scheduler: Scheduler;
  authority: AuthorityResolver;
};
export function scheduleRoute(
  deps: ScheduleRouteDeps,
  operation: (subject: string, request: Parameters<Route>[0]) => ReturnType<Route>,
): Route {
  return async (request) => {
    try {
      const caller = await deps.verify(headerValue(request.headers, IAP_ASSERTION_HEADER));
      return await operation(caller.sub, request);
    } catch (error) {
      if (error instanceof Unauthenticated)
        return { status: 401, body: { error: 'unauthenticated' } };
      if (error instanceof ScheduleDenied) return { status: 403, body: { error: error.code } };
      if (error instanceof ScheduleConflict) return { status: 409, body: { error: 'conflict' } };
      return { status: 503, body: { error: 'scheduling_unavailable' } };
    }
  };
}
export function scheduleJson(body: Buffer): unknown {
  try {
    return JSON.parse(body.toString('utf8')) as unknown;
  } catch {
    return undefined;
  }
}
