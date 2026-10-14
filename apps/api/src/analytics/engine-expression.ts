import { reject } from './errors.js';
import { resolveColumn } from './guard-columns.js';

import type { Expression } from './ast.js';
import type { AnalyticsParams, AnalyticsRow, AnalyticsValue } from './domain.js';
import type { GuardedQuery } from './sql-guard.js';
export type JoinedRow = ReadonlyMap<string, AnalyticsRow>;
export function scalar(
  expr: Expression,
  row: JoinedRow,
  params: AnalyticsParams,
  guarded: GuardedQuery,
): AnalyticsValue {
  if (expr.kind === 'literal') return expr.value;
  if (expr.kind === 'param') return params[expr.name];
  if (expr.kind !== 'column') reject('ENGINE_EXPRESSION');
  const col = resolveColumn(expr, guarded.ast, guarded.datasets);
  return row.get(col.table)?.[col.name] ?? null;
}
export function evaluate(
  expr: Expression,
  rows: readonly JoinedRow[],
  params: AnalyticsParams,
  guarded: GuardedQuery,
): AnalyticsValue {
  if (expr.kind !== 'aggregate') return scalar(expr, rows[0] ?? new Map(), params, guarded);
  const arg = expr.column;
  const values =
    arg === null
      ? rows.map(() => 1)
      : rows.map((r) => scalar(arg, r, params, guarded)).filter((v) => v !== null);
  if (expr.fn === 'COUNT') return values.length;
  if (values.length === 0) return null;
  if (expr.fn === 'MIN' || expr.fn === 'MAX') {
    return values.reduce((best, value) =>
      (expr.fn === 'MIN' ? compare(value, best) < 0 : compare(value, best) > 0) ? value : best,
    );
  }
  if (values.some((v) => typeof v !== 'number')) reject('ENGINE_AGGREGATE');
  const numeric = values as number[];
  const sum = numeric.reduce((total, value) => total + value, 0);
  return expr.fn === 'AVG' ? sum / numeric.length : sum;
}
export function compare(left: AnalyticsValue, right: AnalyticsValue): number {
  if (left === right) return 0;
  if (left === null) return -1;
  if (right === null) return 1;
  if (typeof left === 'number' && typeof right === 'number') return left - right;
  const a = Array.from(String(left), (char) => char.codePointAt(0)!);
  const b = Array.from(String(right), (char) => char.codePointAt(0)!);
  for (let i = 0; i < Math.min(a.length, b.length); i++) {
    const order = a.at(i)! - b.at(i)!;
    if (order !== 0) return order;
  }
  return a.length - b.length;
}
