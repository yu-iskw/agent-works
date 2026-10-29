import type { BqRow } from './live.js';
import type { Calculation, MetricsScope } from '@agent-works/domain/teamwork';

/** The only metric query a segment can run. Group column comes from a closed enum, never text. */
export function monthlyQuery(
  project: string,
  dataset: string,
  groupBy: MetricsScope['groupBy'],
): string {
  const column = groupBy === 'region' ? 'region' : 'channel';
  return [
    `select metric, ${column} as grp, format_date('%Y-%m', day) as period,`,
    `  cast(sum(value) as string) as total, cast(max(day) as string) as last_day`,
    `from \`${project}.${dataset}.daily_kpis\``,
    `where format_date('%Y-%m', day) in unnest(@periods)`,
    `group by metric, grp, period`,
    `order by metric, grp, period`,
  ].join('\n');
}

export function periodsFor(scope: MetricsScope): readonly string[] {
  return [...new Set([scope.baseline, scope.current])];
}

const round = (value: number, decimals: number) => Number(value.toFixed(decimals));

/**
 * Baseline and current totals per metric and group, with change and percent change rounded to
 * one decimal place. Values are summed exactly as BigQuery returned them; nothing is estimated.
 */
export function computeCalculations(
  rows: readonly BqRow[],
  scope: MetricsScope,
  units: ReadonlyMap<string, string>,
): Omit<Calculation, 'id' | 'evidenceId'>[] {
  const totals = new Map<string, number>();
  for (const row of rows) {
    const value = Number(row.total);
    if (!Number.isFinite(value)) continue;
    totals.set(`${row.metric}|${row.grp}|${row.period}`, value);
  }
  const pairs = [...new Set(rows.map((row) => `${row.metric}|${row.grp}`))].sort();
  return pairs.flatMap((pair) => {
    const [metric = '', group = ''] = pair.split('|');
    const before = totals.get(`${pair}|${scope.baseline}`);
    const after = totals.get(`${pair}|${scope.current}`);
    if (before === undefined || after === undefined) return [];
    const decimals = Number.isInteger(before) && Number.isInteger(after) ? 0 : 2;
    return [
      {
        metric,
        unit: units.get(metric) ?? 'unknown unit',
        group,
        groupBy: scope.groupBy,
        baseline: scope.baseline,
        current: scope.current,
        baselineValue: round(before, decimals),
        currentValue: round(after, decimals),
        change: round(after - before, decimals),
        changePct: before === 0 ? null : round(((after - before) / before) * 100, 1),
        query: `monthly_by_${scope.groupBy}`,
      },
    ];
  });
}
