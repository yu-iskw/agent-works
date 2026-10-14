import { analyticsHash, analyticsRerunSchema } from '../analytics/domain.js';
import { reject } from '../analytics/errors.js';
import { checkAnalyticsExecution } from '../analytics/execution.js';
import { executeAnalyticsReportTask } from '../analytics/schedule-task.js';

import type { RegisteredSkill } from './incident.js';
import type { AnalyticsPrincipal, AnalyticsResult } from '../analytics/domain.js';
import type { AnalyticsService } from '../analytics/service.js';
export type AnalystConfig = {
  service: AnalyticsService;
  authority: (subject: string) => Promise<Omit<AnalyticsPrincipal, 'subject'>>;
};
export function createAnalystSkill(
  config: () => AnalystConfig | undefined = () => undefined,
): RegisteredSkill & { result(taskId: string): AnalyticsResult | undefined } {
  const results = new Map<string, AnalyticsResult>();
  const identities = new Map<string, string>();
  const running = new Map<string, Promise<void>>();
  return {
    manifest: {
      id: 'analyst',
      version: '1.0.0',
      tools: ['analytics.report.rerun@1'],
      state: 'PUBLISHED',
    },
    validate: (request) => analyticsRerunSchema.safeParse(request.input).success,
    result: (taskId) => {
      const result = results.get(taskId);
      return result === undefined ? undefined : structuredClone(result);
    },
    async dispatch(request, accepted, authorized, execution) {
      const configured = config();
      if (configured === undefined) reject('ANALYST_UNAVAILABLE', 503);
      const deadline = Math.min(
        Date.parse(accepted.submittedAt) + request.executionPolicy.deadlineSeconds * 1000,
        execution?.deadline ?? Infinity,
      );
      checkAnalyticsExecution({ ...execution, deadline });
      const identity = analyticsHash({ subject: authorized.caller.sub, input: request.input });
      const previous = identities.get(accepted.taskId);
      if (previous !== undefined && previous !== identity) reject('ANALYST_TASK_CONFLICT', 409);
      identities.set(accepted.taskId, identity);
      if (results.has(accepted.taskId)) return;
      const existing = running.get(accepted.taskId);
      if (existing !== undefined) return existing;
      const operation = Promise.resolve().then(async () => {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), Math.max(0, deadline - Date.now()));
        const controls = {
          deadline,
          signal: AbortSignal.any([
            controller.signal,
            ...(execution?.signal === undefined ? [] : [execution.signal]),
          ]),
        };
        try {
          const authority = await configured.authority(authorized.caller.sub);
          checkAnalyticsExecution(controls);
          const result = await executeAnalyticsReportTask(
            configured.service,
            {
              ...authority,
              subject: authorized.caller.sub,
              datasets: authority.datasets.filter((dataset) =>
                authorized.context.allowedSources.includes(dataset),
              ),
            },
            request.input,
            accepted.taskId,
            controls,
          );
          results.set(accepted.taskId, result);
        } finally {
          clearTimeout(timer);
        }
      });
      running.set(accepted.taskId, operation);
      try {
        await operation;
      } finally {
        running.delete(accepted.taskId);
      }
    },
  };
}
