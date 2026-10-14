import { analyticsMetricRoutes } from '../routes/analytics-metrics.js';
import { analyticsQueryRoutes } from '../routes/analytics-query.js';
import { analyticsReportRoutes } from '../routes/analytics-reports.js';

import type { Route } from '../http.js';
import type { AnalyticsRouteDeps } from '../routes/analytics-auth.js';
/** Explicit trusted injection, matching governance and schedule route registration. */
export function analyticsRoutes(
  deps: AnalyticsRouteDeps | undefined,
): Readonly<Record<string, Route>> {
  return deps === undefined
    ? {}
    : {
        ...analyticsQueryRoutes(deps),
        ...analyticsMetricRoutes(deps),
        ...analyticsReportRoutes(deps),
      };
}
