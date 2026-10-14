import { classificationFloor } from './classification.js';
import { reject } from './errors.js';

import type { Column, Expression, SelectAst } from './ast.js';
import type { AnalyticsClassification, AnalyticsDataset } from './domain.js';
export type ResolvedColumn = {
  table: string;
  name: string;
  classification: AnalyticsClassification;
};
export function resolveColumn(
  col: Column,
  ast: SelectAst,
  datasets: readonly AnalyticsDataset[],
): ResolvedColumn {
  const matches = ast.tables
    .filter((t) => col.table === null || t.alias === col.table)
    .flatMap((t) => {
      const dataset = datasets.find((d) => d.name === t.name);
      const found = dataset?.columns.find((c) => c.name === col.name);
      return found === undefined ? [] : [{ table: t.alias, ...found }];
    });
  if (matches.length !== 1) reject('COLUMN_NOT_ALLOWED');
  return matches[0];
}
export function expressionClassification(
  expr: Expression,
  ast: SelectAst,
  datasets: readonly AnalyticsDataset[],
): AnalyticsClassification {
  if (expr.kind === 'column') return resolveColumn(expr, ast, datasets).classification;
  if (expr.kind !== 'aggregate') return 'PUBLIC';
  if (expr.column !== null) {
    const classification = resolveColumn(expr.column, ast, datasets).classification;
    if (expr.fn !== 'COUNT') return classification;
  }
  // Both COUNT(*) and COUNT(column) reveal membership in the scanned views.
  return datasets
    .filter((d) => ast.tables.some((t) => t.name === d.name))
    .flatMap((d) => d.columns)
    .reduce(
      (floor, c) => classificationFloor(floor, c.classification),
      'PUBLIC' as AnalyticsClassification,
    );
}
export function validateGrouping(ast: SelectAst): void {
  const aggregate = ast.projections.some((p) => p.expression.kind === 'aggregate');
  if (!aggregate && ast.groupBy.length > 0) reject('SQL_GROUP');
  if (!aggregate) return;
  for (const p of ast.projections) {
    const e = p.expression;
    if (e.kind === 'column' && !ast.groupBy.some((c) => c.name === e.name && c.table === e.table))
      reject('SQL_GROUP');
  }
}
