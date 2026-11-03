import { scopePredicate } from './aggregate.js';
import { P08_PROVISIONAL_ATTRIBUTION } from './billing.js';

import type { OpsDashboard } from './types.js';
import type postgres from 'postgres';

type ReconciliationCheck = {
  readonly name: string;
  readonly dashboard: number;
  readonly ledger: number;
  readonly delta: number;
};
export type Reconciliation = {
  readonly ok: boolean;
  readonly checks: readonly ReconciliationCheck[];
  /** P08 on the ledger side: recorded usage owned by an execution, member and team. */
  readonly ledgerAttribution: {
    readonly estimatedMicros: number;
    readonly attributedMicros: number;
    readonly ratio: number | null;
    readonly meetsProvisionalTarget: boolean | null;
  };
};

/**
 * Re-reads the raw execution-ledger rows and sums them in code, independent of the SQL
 * aggregates behind the dashboard, then reports every delta. ok means every delta is zero.
 */
export async function reconcileDashboard(
  sql: postgres.Sql,
  view: OpsDashboard,
): Promise<Reconciliation> {
  const rows = await sql<
    {
      state: string;
      estimated: string;
      recorded: string;
      member_id: string;
      segment_id: string;
      bot_id: string;
    }[]
  >`select r.state, r.estimated_cost_micros::text as estimated, r.cost_micros::text as recorded,
      r.member_id, r.segment_id, r.bot_id
    from admission_reservations r
    where r.created_at >= ${view.window.from}::timestamptz and r.created_at < ${view.window.to}::timestamptz
      and ${scopePredicate(sql, view.scope)}`;
  let estimated = 0;
  let recorded = 0;
  let succeeded = 0;
  let attributed = 0;
  for (const row of rows) {
    estimated += Number(row.estimated);
    recorded += Number(row.recorded);
    if (row.state === 'succeeded') succeeded += 1;
    if (row.member_id !== '' && row.segment_id !== '' && row.bot_id !== '')
      attributed += Number(row.estimated);
  }
  const check = (name: string, dashboard: number, ledger: number): ReconciliationCheck => ({
    name,
    dashboard,
    ledger,
    delta: dashboard - ledger,
  });
  const checks = [
    check('executions', view.cost.estimated.executions, rows.length),
    check('estimatedMicros', view.cost.estimated.estimatedMicros, estimated),
    check('recordedMicros', view.cost.estimated.recordedMicros, recorded),
    check('succeededExecutions', view.cost.succeededExecutions, succeeded),
  ];
  const ratio = estimated === 0 ? null : attributed / estimated;
  return {
    ok: checks.every((entry) => entry.delta === 0),
    checks,
    ledgerAttribution: {
      estimatedMicros: estimated,
      attributedMicros: attributed,
      ratio,
      meetsProvisionalTarget: ratio === null ? null : ratio >= P08_PROVISIONAL_ATTRIBUTION,
    },
  };
}
