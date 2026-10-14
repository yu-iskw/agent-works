import { analyticsRerunSchema } from './domain.js';

import type { AnalyticsPrincipal } from './domain.js';
import type { AnalyticsExecution } from './execution.js';
import type { AnalyticsService } from './service.js';
/** Existing schedules dispatch the analyst skill with this frozen version reference.
 * Scheduler authority and sponsor checks remain in the existing scheduling pipeline. */
export async function executeAnalyticsReportTask(
  service: AnalyticsService,
  principal: AnalyticsPrincipal,
  input: unknown,
  taskId: string,
  execution?: AnalyticsExecution,
) {
  const command = analyticsRerunSchema.parse(input);
  return service.rerun(principal, command.versionId, command.maxBytes, taskId, execution);
}
