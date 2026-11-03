import { loadLedgerOwners } from './aggregate.js';
import { attributeLines, parseBillingExport, summarizeAttribution } from './billing.js';

import type { BillingAttribution } from './billing.js';
import type postgres from 'postgres';

export type BillingSampleReport = BillingAttribution & {
  /** Billed micros per team label, from execution owners or team labels. */
  readonly bySegment: Readonly<Record<string, number>>;
  /** attributed + unassigned equals the export total. A false here means a dropped line. */
  readonly balanced: boolean;
};

/**
 * Takes an operator-provided billing export (format in docs/plans/enterprise-production-v1/ops-02)
 * and computes how much of it the execution ledger can attribute.
 */
export async function reconcileBillingSample(
  sql: postgres.Sql,
  text: string,
  format: 'csv' | 'json',
): Promise<BillingSampleReport> {
  const lines = parseBillingExport(text, format);
  const owners = await loadLedgerOwners(
    sql,
    lines.flatMap((line) => (line.executionId === null ? [] : [line.executionId])),
  );
  const attributed = attributeLines(lines, owners);
  const summary = summarizeAttribution(attributed);
  const bySegment: Record<string, number> = {};
  for (const row of attributed)
    if (row.segmentId !== null)
      bySegment[row.segmentId] = (bySegment[row.segmentId] ?? 0) + row.line.amountMicros;
  return {
    ...summary,
    bySegment,
    balanced: summary.attributedMicros + summary.unassignedMicros === summary.totalMicros,
  };
}
