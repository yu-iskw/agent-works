import { analyticsRoute } from './analytics-auth.js';

import type { AnalyticsRouteDeps } from './analytics-auth.js';
import type { Route } from '../http.js';
export function analyticsMetricRoutes(deps: AnalyticsRouteDeps): Record<string, Route> {
  return {
    'GET /v1/analytics/metrics': analyticsRoute(deps, async (principal) => ({
      status: 200,
      body: { metrics: await deps.service.metrics(principal) },
    })),
  };
}
