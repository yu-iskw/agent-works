import { IAP_ASSERTION_HEADER } from '@agent-works/domain';
import { ZodError } from 'zod';

import { AnalyticsError } from '../analytics/errors.js';
import { Unauthenticated } from '../auth/iap.js';
import { headerValue } from '../http.js';

import type { AnalyticsPrincipal } from '../analytics/domain.js';
import type { AnalyticsService } from '../analytics/service.js';
import type { VerifyAssertion } from '../auth/iap.js';
import type { Route } from '../http.js';
export type AnalyticsRouteDeps = {
  verify: VerifyAssertion;
  authority: (subject: string) => Promise<Omit<AnalyticsPrincipal, 'subject'>>;
  service: AnalyticsService;
};
export function analyticsJson(body: Buffer): unknown {
  if (body.length > 16384) throw new SyntaxError('body too large');
  return JSON.parse(body.toString('utf8')) as unknown;
}
export function analyticsRoute(
  deps: AnalyticsRouteDeps,
  operation: (principal: AnalyticsPrincipal, request: Parameters<Route>[0]) => ReturnType<Route>,
): Route {
  return async (request) => {
    try {
      const caller = await deps.verify(headerValue(request.headers, IAP_ASSERTION_HEADER));
      const authority = await deps.authority(caller.sub);
      if (!authority.roles.includes('analyst'))
        return { status: 403, body: { error: 'FORBIDDEN' } };
      return await operation({ ...authority, subject: caller.sub }, request);
    } catch (error) {
      if (error instanceof Unauthenticated)
        return { status: 401, body: { error: 'UNAUTHENTICATED' } };
      if (error instanceof AnalyticsError)
        return { status: error.status, body: { error: error.code } };
      if (error instanceof ZodError || error instanceof SyntaxError)
        return { status: 400, body: { error: 'INVALID_ANALYTICS_REQUEST' } };
      return { status: 503, body: { error: 'ANALYTICS_UNAVAILABLE' } };
    }
  };
}
