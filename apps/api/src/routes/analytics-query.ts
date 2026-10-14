import { analyticsQuerySchema } from '../analytics/domain.js';

import { analyticsJson, analyticsRoute } from './analytics-auth.js';

import type { AnalyticsRouteDeps } from './analytics-auth.js';
import type { Route } from '../http.js';
export function analyticsQueryRoutes(deps: AnalyticsRouteDeps): Record<string, Route> {
  return {
    'POST /v1/analytics/query': analyticsRoute(deps, async (principal, request) => ({
      status: 200,
      body: await deps.service.query(
        principal,
        analyticsQuerySchema.parse(analyticsJson(request.body)),
      ),
    })),
  };
}
