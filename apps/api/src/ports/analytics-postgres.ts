import {
  analyticsAuditSchema,
  analyticsDatasetSchema,
  analyticsMetricSchema,
  analyticsReportSchema,
} from '../analytics/domain.js';
import { analyticsReady } from '../analytics/migration.js';
import { createAnalyticsPort } from '../analytics/store.js';

import type {
  AnalyticsAudit,
  AnalyticsDriver,
  AnalyticsPort,
  AnalyticsState,
} from './analytics.js';
import type postgres from 'postgres';
export function createPostgresAnalyticsPort(sql: postgres.Sql): AnalyticsPort {
  const driver: AnalyticsDriver = {
    async transaction<T>(operation: (state: AnalyticsState) => T): Promise<T> {
      await analyticsReady(sql);
      return (await sql.begin(async (tx) => {
        await tx`select pg_advisory_xact_lock(7015)`;
        const state = await read(tx);
        const before = structuredClone(state);
        const result = operation(state);
        await save(tx, state, before);
        return structuredClone(result);
      })) as T;
    },
  };
  return createAnalyticsPort(driver);
}
async function read(tx: postgres.TransactionSql): Promise<AnalyticsState> {
  const datasets = await tx<
    { payload: unknown }[]
  >`select payload from analytics_datasets order by name`;
  const metrics = await tx<
    { payload: unknown }[]
  >`select payload from analytics_metrics order by name`;
  const reports = await tx<
    { payload: unknown }[]
  >`select payload from analytics_report_versions order by report_id,version`;
  const audits = await tx<
    { payload: AnalyticsAudit }[]
  >`select payload from analytics_query_audit order by seq`;
  return {
    datasets: datasets.map((r) => analyticsDatasetSchema.parse(r.payload)),
    metrics: metrics.map((r) => analyticsMetricSchema.parse(r.payload)),
    reports: reports.map((r) => analyticsReportSchema.parse(r.payload)),
    audits: audits.map((r) => analyticsAuditSchema.parse(r.payload)),
  };
}
async function save(
  tx: postgres.TransactionSql,
  state: AnalyticsState,
  before: AnalyticsState,
): Promise<void> {
  for (const row of state.datasets) {
    await tx`insert into analytics_datasets(name,payload) values(${row.name},${tx.json(row)}) on conflict(name) do update set payload=excluded.payload`;
  }
  for (const row of state.metrics) {
    await tx`insert into analytics_metrics(name,dataset_name,payload) values(${row.name},${row.dataset},${tx.json(row)}) on conflict(name) do update set dataset_name=excluded.dataset_name,payload=excluded.payload`;
  }
  for (const row of state.reports) {
    if (before.reports.some((r) => r.id === row.id)) continue;
    await tx`insert into analytics_report_versions(id,report_id,version,owner_sub,query_hash,payload) values(${row.id},${row.reportId},${row.version},${row.owner},${row.hash},${tx.json(row)})`;
  }
  for (const row of state.audits) {
    if (before.audits.some((r) => r.id === row.id)) continue;
    await tx`insert into analytics_query_audit(id,occurred_at,outcome,payload) values(${row.id},${row.at},${row.outcome},${tx.json(row)})`;
  }
}
