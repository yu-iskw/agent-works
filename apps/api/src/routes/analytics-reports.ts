import { analyticsRerunSchema, analyticsSaveSchema } from '../analytics/domain.js';

import { analyticsJson, analyticsRoute } from './analytics-auth.js';

import type { AnalyticsRouteDeps } from './analytics-auth.js';
import type { Route } from '../http.js';
export function analyticsReportRoutes(deps: AnalyticsRouteDeps): Record<string, Route> {
  return {
    'GET /v1/analytics/reports': analyticsRoute(deps, async (principal) => ({
      status: 200,
      body: { reports: await deps.service.reports(principal) },
    })),
    'POST /v1/analytics/reports': analyticsRoute(deps, async (principal, request) => ({
      status: 201,
      body: await deps.service.save(
        principal,
        analyticsSaveSchema.parse(analyticsJson(request.body)),
      ),
    })),
    'POST /v1/analytics/reports/rerun': analyticsRoute(deps, async (principal, request) => {
      const input = analyticsRerunSchema.parse(analyticsJson(request.body));
      return {
        status: 200,
        body: await deps.service.rerun(principal, input.versionId, input.maxBytes),
      };
    }),
  };
}
