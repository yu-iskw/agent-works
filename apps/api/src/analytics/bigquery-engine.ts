import { reject } from './errors.js';
import { checkAnalyticsExecution } from './execution.js';

import type { AnalyticsParams, AnalyticsRow } from './domain.js';
import type { AnalyticsExecution } from './execution.js';
import type { EngineQuery, QueryEngine } from '../ports/analytics.js';
export type BigQueryRequest = AnalyticsExecution & {
  query: string;
  params: AnalyticsParams;
  useLegacySql: false;
  dryRun: boolean;
  maximumBytesBilled: string;
  location: string;
};
/** Inject an authenticated transport. No network, SDK, or credentials in offline mode. */
export interface BigQueryTransport {
  dryRun(request: BigQueryRequest): Promise<{ totalBytesProcessed: string }>;
  query(request: BigQueryRequest): Promise<readonly AnalyticsRow[]>;
}
export function createBigQueryEngine(
  transport: BigQueryTransport,
  config: { enabled: boolean; location: string },
): QueryEngine {
  function request(query: EngineQuery, dryRun: boolean): BigQueryRequest {
    checkAnalyticsExecution(query.execution);
    if (!config.enabled) reject('BIGQUERY_DISABLED', 503);
    if (config.location !== 'asia-northeast1') reject('BIGQUERY_LOCATION', 503);
    return {
      ...query.execution,
      query: query.plan.sql,
      params: structuredClone(query.plan.params),
      useLegacySql: false,
      dryRun,
      maximumBytesBilled: String(query.maxBytes),
      location: config.location,
    };
  }
  return {
    async dryRun(query) {
      const result = await transport.dryRun(request(query, true));
      if (!/^\d+$/.test(result.totalBytesProcessed)) reject('INVALID_ESTIMATE', 503);
      const bytes = Number(result.totalBytesProcessed);
      if (!Number.isSafeInteger(bytes)) reject('INVALID_ESTIMATE', 503);
      return { bytes };
    },
    execute: (query) => transport.query(request(query, false)),
  };
}
