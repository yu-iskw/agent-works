import { maskRows } from './classification.js';
import {
  analyticsAuditSchema,
  analyticsDatasetSchema,
  analyticsMetricSchema,
  analyticsPlanHash,
  analyticsReportSchema,
} from './domain.js';
import { reject } from './errors.js';

import type { AnalyticsDriver, AnalyticsPort } from '../ports/analytics.js';
export function createAnalyticsPort(driver: AnalyticsDriver): AnalyticsPort {
  return {
    catalog: () =>
      driver.transaction((s) => ({
        metrics: [...s.metrics].sort((a, b) => a.name.localeCompare(b.name)),
        datasets: [...s.datasets].sort((a, b) => a.name.localeCompare(b.name)),
      })),
    putMetric: (input) =>
      driver.transaction((s) => {
        const metric = analyticsMetricSchema.parse(input);
        if (!s.datasets.some((d) => d.name === metric.dataset)) reject('DATASET_NOT_ALLOWED');
        s.metrics = [...s.metrics.filter((m) => m.name !== metric.name), metric];
      }),
    putDataset: (input) =>
      driver.transaction((s) => {
        const dataset = analyticsDatasetSchema.parse(input);
        s.datasets = [...s.datasets.filter((d) => d.name !== dataset.name), dataset];
      }),
    saveReport: (input) =>
      driver.transaction((s) => {
        if (s.reports.some((r) => r.id === input.id)) reject('VERSION_EXISTS', 409);
        const previous = s.reports.filter((r) => r.reportId === input.reportId);
        if (previous.some((r) => r.owner !== input.owner)) reject('REPORT_FORBIDDEN', 403);
        if (input.owner !== input.validatedBy) reject('REPORT_VALIDATOR', 403);
        const version = previous.reduce((v, r) => Math.max(v, r.version), 0) + 1;
        const report = analyticsReportSchema.parse({
          ...input,
          version,
          hash: analyticsPlanHash(input),
        });
        s.reports.push(report);
        return report;
      }),
    report: (id) => driver.transaction((s) => s.reports.find((r) => r.id === id)),
    reports: (subject) =>
      driver.transaction((s) =>
        s.reports
          .filter((r) => r.owner === subject)
          .sort((a, b) => a.reportId.localeCompare(b.reportId) || a.version - b.version),
      ),
    audit: (event) =>
      driver.transaction((s) => {
        if (s.audits.some((a) => a.id === event.id)) reject('AUDIT_EXISTS', 409);
        s.audits.push(
          analyticsAuditSchema.parse({ ...event, rows: maskRows(event.rows, event.columns) }),
        );
      }),
    audits: () => driver.transaction((s) => s.audits),
  };
}
