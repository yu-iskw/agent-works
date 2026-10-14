import { randomUUID } from 'node:crypto';

import { maskRows } from './classification.js';
import { compileMetric } from './compiler.js';
import { costGate } from './cost-gate.js';
import {
  analyticsHash,
  analyticsPlanHash,
  analyticsQuerySchema,
  analyticsSaveSchema,
} from './domain.js';
import { AnalyticsError, reject } from './errors.js';
import { checkAnalyticsExecution } from './execution.js';
import { guardSql } from './sql-guard.js';

import type { AnalyticsBudget } from './cost-gate.js';
import type {
  AnalyticsPlan,
  AnalyticsPrincipal,
  AnalyticsQuery,
  AnalyticsReport,
  AnalyticsResult,
  AnalyticsSave,
} from './domain.js';
import type { AnalyticsExecution } from './execution.js';
import type { GuardLimits } from './sql-guard.js';
import type { AnalyticsAudit, AnalyticsPort, QueryEngine } from '../ports/analytics.js';
export type AnalyticsServiceDeps = {
  port: AnalyticsPort;
  engine: QueryEngine;
  budget: AnalyticsBudget;
  limits: GuardLimits;
  now: () => Date;
};
export function createAnalyticsService(deps: AnalyticsServiceDeps) {
  async function run(
    principal: AnalyticsPrincipal,
    plan: AnalyticsPlan,
    maxBytes: number,
    options: { taskId?: string; rowCap?: number; execution?: AnalyticsExecution } = {},
  ): Promise<AnalyticsResult> {
    const { taskId, rowCap = deps.limits.maxRows, execution } = options;
    const queryId = randomUUID();
    const at = deps.now().toISOString();
    const event: AnalyticsAudit = {
      id: queryId,
      at,
      subjectHash: analyticsHash(principal.subject),
      queryHash: analyticsHash(plan.sql),
      paramsHash: analyticsHash(plan.params),
      outcome: 'denied',
      reason: null,
      vetted: plan.vetted,
      estimatedBytes: null,
      columns: {},
      rows: [],
    };
    let reserved = false;
    try {
      checkAnalyticsExecution(execution);
      const catalog = await deps.port.catalog();
      const guarded = guardSql(plan.sql, plan.params, catalog.datasets, principal, {
        ...deps.limits,
        maxRows: Math.min(deps.limits.maxRows, rowCap),
        floor: plan.classification,
      });
      const cap = Math.min(
        maxBytes,
        deps.limits.maxBytes,
        ...guarded.datasets.map((d) => d.maxBytes),
      );
      if (!Number.isSafeInteger(cap) || cap < 1) reject('INVALID_BYTE_CAP');
      const query = { plan, guarded, maxBytes: cap, execution };
      checkAnalyticsExecution(execution);
      const estimate = await deps.engine.dryRun(query);
      if (Number.isSafeInteger(estimate.bytes) && estimate.bytes >= 0)
        event.estimatedBytes = estimate.bytes;
      checkAnalyticsExecution(execution);
      await costGate(estimate.bytes, cap, deps.budget, {
        queryId,
        subject: principal.subject,
        taskId: taskId ?? queryId,
        at,
      });
      reserved = true;
      checkAnalyticsExecution(execution);
      const rows = maskRows(await deps.engine.execute(query), guarded.columns);
      checkAnalyticsExecution(execution);
      if (rows.length > guarded.ast.limit) reject('ENGINE_ROW_CAP', 503);
      event.outcome = 'allowed';
      event.columns = guarded.columns;
      // Query-supplied values belong only in caller results, never in evidence.
      const classifications = new Map(Object.entries(guarded.columns));
      const evidenceColumns = Object.fromEntries(
        guarded.ast.projections.map(({ alias, expression }) => [
          alias,
          expression.kind === 'param' || expression.kind === 'literal'
            ? 'RESTRICTED'
            : (classifications.get(alias) ?? 'RESTRICTED'),
        ]),
      );
      event.rows = maskRows(rows, evidenceColumns);
      return {
        queryId,
        sql: plan.sql,
        paramsHash: event.paramsHash,
        vetted: plan.vetted,
        estimatedBytes: estimate.bytes,
        columns: guarded.columns,
        rows,
      };
    } catch (error) {
      event.reason = error instanceof AnalyticsError ? error.code : 'ANALYTICS_UNAVAILABLE';
      event.outcome = error instanceof AnalyticsError && error.status < 500 ? 'denied' : 'failed';
      throw error;
    } finally {
      // Audit failures fail closed, including an otherwise successful execution.
      try {
        await deps.port.audit(event);
      } finally {
        if (reserved) await deps.budget.port.release(queryId);
      }
    }
  }
  async function planFor(query: AnalyticsQuery): Promise<AnalyticsPlan> {
    analyticsQuerySchema.parse(query);
    return compileMetric(query, (await deps.port.catalog()).metrics);
  }
  return {
    async query(
      principal: AnalyticsPrincipal,
      query: AnalyticsQuery,
      taskId?: string,
    ): Promise<AnalyticsResult> {
      return run(principal, await planFor(query), query.maxBytes, { taskId, rowCap: query.limit });
    },
    async metrics(principal: AnalyticsPrincipal) {
      if (!principal.roles.includes('analyst')) reject('FORBIDDEN', 403);
      return (await deps.port.catalog()).metrics.filter((m) =>
        principal.datasets.includes(m.dataset),
      );
    },
    async reports(principal: AnalyticsPrincipal) {
      if (!principal.roles.includes('analyst')) reject('FORBIDDEN', 403);
      return deps.port.reports(principal.subject);
    },
    async save(principal: AnalyticsPrincipal, input: AnalyticsSave): Promise<AnalyticsReport> {
      analyticsSaveSchema.parse(input);
      const plan = await planFor(input.query);
      await run(principal, plan, input.query.maxBytes, { rowCap: input.query.limit });
      return deps.port.saveReport({
        ...plan,
        id: randomUUID(),
        reportId: input.reportId,
        title: input.title,
        owner: principal.subject,
        validatedBy: principal.subject,
        validatedAt: deps.now().toISOString(),
      });
    },
    async rerun(
      principal: AnalyticsPrincipal,
      versionId: string,
      maxBytes: number,
      taskId?: string,
      execution?: AnalyticsExecution,
    ): Promise<AnalyticsResult> {
      checkAnalyticsExecution(execution);
      const report = await deps.port.report(versionId);
      if (report === undefined) reject('REPORT_NOT_FOUND', 404);
      if (report.owner !== principal.subject || !principal.roles.includes('analyst'))
        reject('REPORT_FORBIDDEN', 403);
      if (report.hash !== analyticsPlanHash(report)) reject('REPORT_INTEGRITY', 409);
      return run(principal, report, maxBytes, { taskId, execution });
    },
  };
}
export type AnalyticsService = ReturnType<typeof createAnalyticsService>;
