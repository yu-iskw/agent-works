import type {
  AnalyticsAudit,
  AnalyticsDataset,
  AnalyticsMetric,
  AnalyticsPlan,
  AnalyticsReport,
  AnalyticsRow,
} from '../analytics/domain.js';
import type { AnalyticsExecution } from '../analytics/execution.js';
import type { GuardedQuery } from '../analytics/sql-guard.js';
export type { AnalyticsAudit } from '../analytics/domain.js';
export type AnalyticsState = {
  metrics: AnalyticsMetric[];
  datasets: AnalyticsDataset[];
  reports: AnalyticsReport[];
  audits: AnalyticsAudit[];
};
export interface AnalyticsDriver {
  transaction<T>(operation: (state: AnalyticsState) => T): Promise<T>;
}
export interface AnalyticsPort {
  catalog(): Promise<{
    metrics: readonly AnalyticsMetric[];
    datasets: readonly AnalyticsDataset[];
  }>;
  putMetric(metric: AnalyticsMetric): Promise<void>;
  putDataset(dataset: AnalyticsDataset): Promise<void>;
  saveReport(input: Omit<AnalyticsReport, 'version' | 'hash'>): Promise<AnalyticsReport>;
  report(id: string): Promise<AnalyticsReport | undefined>;
  reports(subject: string): Promise<readonly AnalyticsReport[]>;
  audit(event: AnalyticsAudit): Promise<void>;
  audits(): Promise<readonly AnalyticsAudit[]>;
}
export type EngineQuery = {
  plan: AnalyticsPlan;
  guarded: GuardedQuery;
  maxBytes: number;
  execution?: AnalyticsExecution;
};
export interface QueryEngine {
  dryRun(query: EngineQuery): Promise<{ bytes: number }>;
  execute(query: EngineQuery): Promise<readonly AnalyticsRow[]>;
}
