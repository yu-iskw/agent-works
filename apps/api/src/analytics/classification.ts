import { redactClassifiedPayload } from '../audit/siem-export/redact-governance.js';

import { analyticsRowsSchema } from './domain.js';
import { reject } from './errors.js';

import type { AnalyticsClassification, AnalyticsRow } from './domain.js';
const labels: readonly AnalyticsClassification[] = [
  'PUBLIC',
  'INTERNAL',
  'CONFIDENTIAL',
  'RESTRICTED',
];
export function classificationFloor(
  a: AnalyticsClassification,
  b: AnalyticsClassification,
): AnalyticsClassification {
  return labels[Math.max(labels.indexOf(a), labels.indexOf(b))];
}
export function maskRows(
  rows: readonly AnalyticsRow[],
  columns: Readonly<Record<string, AnalyticsClassification>>,
): AnalyticsRow[] {
  const masked = rows.map((row) => {
    const values = new Map(Object.entries(row));
    return Object.fromEntries(
      Object.entries(columns).map(([key, classification]) => [
        key,
        redactClassifiedPayload(values.get(key) ?? null, classification),
      ]),
    );
  });
  const parsed = analyticsRowsSchema.safeParse(masked);
  if (!parsed.success) reject('ENGINE_RESULT', 503);
  return parsed.data;
}
