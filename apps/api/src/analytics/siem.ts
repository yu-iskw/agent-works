import { maskRows } from './classification.js';

import type { AnalyticsAudit } from '../ports/analytics.js';
/** Export only digests and masked results; never raw SQL, parameters, or user identifiers. */
export function analyticsSiem(event: AnalyticsAudit): Readonly<Record<string, unknown>> {
  return {
    version: '1',
    event_id: event.id,
    event_type: 'analytics.query',
    occurred_at: event.at,
    actor_digest: event.subjectHash,
    query_digest: event.queryHash,
    params_digest: event.paramsHash,
    outcome: event.outcome,
    reason: event.reason,
    vetted: event.vetted,
    estimated_bytes: event.estimatedBytes,
    columns: event.columns,
    rows: maskRows(event.rows, event.columns),
  };
}
