import { classificationFloor } from './classification.js';
import { analyticsParams } from './domain.js';
import { reject } from './errors.js';
import { expressionClassification, resolveColumn, validateGrouping } from './guard-columns.js';
import { parseSelect } from './parser.js';

import type { SelectAst } from './ast.js';
import type {
  AnalyticsClassification,
  AnalyticsDataset,
  AnalyticsParams,
  AnalyticsPrincipal,
} from './domain.js';
export type GuardedQuery = {
  ast: SelectAst;
  columns: Record<string, AnalyticsClassification>;
  datasets: readonly AnalyticsDataset[];
};
export type GuardLimits = { maxJoins: number; maxRows: number; maxBytes: number };
export function guardSql(
  sql: string,
  params: AnalyticsParams,
  datasets: readonly AnalyticsDataset[],
  principal: AnalyticsPrincipal,
  limits: GuardLimits & { floor?: AnalyticsClassification },
): GuardedQuery {
  analyticsParams.parse(params);
  if (!principal.roles.includes('analyst')) reject('FORBIDDEN', 403);
  const ast = parseSelect(sql);
  checkTables(ast, datasets, principal, limits);
  const columns = checkColumns(ast, datasets, params, limits.floor ?? 'PUBLIC');
  checkPartitions(ast, datasets, params);
  validateGrouping(ast);
  checkRestrictedCardinality(ast, datasets);
  return {
    ast,
    columns,
    datasets: datasets.filter((d) => ast.tables.some((t) => t.name === d.name)),
  };
}
function checkTables(
  ast: SelectAst,
  datasets: readonly AnalyticsDataset[],
  principal: AnalyticsPrincipal,
  limits: GuardLimits,
): void {
  if (ast.limit < 1 || ast.limit > limits.maxRows) reject('SQL_LIMIT_CAP');
  if (ast.joins.length > limits.maxJoins) reject('SQL_JOIN_CAP');
  if (new Set(ast.tables.map((t) => t.alias)).size !== ast.tables.length) reject('SQL_ALIAS');
  for (const table of ast.tables) {
    if (!datasets.some((d) => d.name === table.name)) reject('DATASET_NOT_ALLOWED');
    if (!principal.datasets.includes(table.name)) reject('DATASET_FORBIDDEN', 403);
  }
  checkJoins(ast, datasets);
}
function checkJoins(ast: SelectAst, datasets: readonly AnalyticsDataset[]): void {
  for (const [index, join] of ast.joins.entries()) {
    if (join.right.kind !== 'column') reject('SQL_JOIN');
    const left = resolveColumn(join.left, ast, datasets);
    const right = resolveColumn(join.right, ast, datasets);
    const current = ast.tables[index + 1].alias;
    const previous = ast.tables.slice(0, index + 1).map((t) => t.alias);
    if (!(
      (left.table === current && previous.includes(right.table)) ||
      (right.table === current && previous.includes(left.table))
    ))
      reject('SQL_JOIN');
  }
}
function checkColumns(
  ast: SelectAst,
  datasets: readonly AnalyticsDataset[],
  params: AnalyticsParams,
  floor: AnalyticsClassification,
): Record<string, AnalyticsClassification> {
  const columns = new Map<string, AnalyticsClassification>();
  const used = new Set<string>();
  // Every output depends on membership selected by filters and joins.
  for (const filter of [...ast.filters, ...ast.joins]) {
    floor = classificationFloor(floor, resolveColumn(filter.left, ast, datasets).classification);
    floor = classificationFloor(floor, expressionClassification(filter.right, ast, datasets));
    if (filter.right.kind === 'param') used.add(filter.right.name);
  }
  for (const p of ast.projections) {
    if (invalidAlias(p.alias, columns)) reject('SQL_ALIAS');
    columns.set(
      p.alias,
      classificationFloor(expressionClassification(p.expression, ast, datasets), floor),
    );
    if (p.expression.kind === 'param') used.add(p.expression.name);
  }
  for (const col of ast.groupBy) resolveColumn(col, ast, datasets);
  validateOrderAndParams(ast, columns, used, params);
  // Sort keys influence both row ordering and which rows survive LIMIT.
  const sortFloor = ast.orderBy.reduce(
    (classification, sort) => classificationFloor(classification, columns.get(sort.name)!),
    'PUBLIC' as AnalyticsClassification,
  );
  for (const [alias, classification] of columns)
    columns.set(alias, classificationFloor(classification, sortFloor));
  return Object.fromEntries(columns);
}
function checkRestrictedCardinality(ast: SelectAst, datasets: readonly AnalyticsDataset[]): void {
  // Masking cells cannot conceal the number of groups formed by a restricted key.
  if (ast.groupBy.some((col) => resolveColumn(col, ast, datasets).classification === 'RESTRICTED'))
    reject('SQL_RESTRICTED_GROUP');
  const restrictedMembership = [...ast.filters, ...ast.joins].some(
    (predicate) =>
      resolveColumn(predicate.left, ast, datasets).classification === 'RESTRICTED' ||
      expressionClassification(predicate.right, ast, datasets) === 'RESTRICTED',
  );
  // Only an ungrouped aggregate has fixed cardinality, including on empty input.
  if (
    restrictedMembership &&
    (ast.groupBy.length > 0 || !ast.projections.some((p) => p.expression.kind === 'aggregate'))
  )
    reject('SQL_RESTRICTED_PREDICATE');
}
function checkPartitions(
  ast: SelectAst,
  datasets: readonly AnalyticsDataset[],
  params: AnalyticsParams,
): void {
  for (const table of ast.tables) {
    const dataset = datasets.find((d) => d.name === table.name);
    if (dataset === undefined) reject('DATASET_NOT_ALLOWED');
    const bounded = ast.filters.some((f) => {
      const resolved = resolveColumn(f.left, ast, datasets);
      if (
        resolved.table !== table.alias ||
        resolved.name !== dataset.partitionColumn ||
        !['=', '>=', '>'].includes(f.op)
      )
        return false;
      const value =
        f.right.kind === 'literal'
          ? f.right.value
          : f.right.kind === 'param'
            ? params[f.right.name]
            : null;
      return (
        typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) && validPartitionDate(value)
      );
    });
    if (!bounded) reject('SQL_PARTITION_REQUIRED');
  }
}

function validPartitionDate(value: string): boolean {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && new Date(parsed).toISOString().slice(0, 10) === value;
}

function validateOrderAndParams(
  ast: SelectAst,
  columns: ReadonlyMap<string, AnalyticsClassification>,
  used: ReadonlySet<string>,
  params: AnalyticsParams,
): void {
  for (const sort of ast.orderBy) if (!columns.has(sort.name)) reject('SQL_ORDER');
  if (
    used.size !== Object.keys(params).length ||
    [...used].some((name) => !Object.hasOwn(params, name))
  )
    reject('SQL_PARAMS');
}

function invalidAlias(
  alias: string,
  columns: ReadonlyMap<string, AnalyticsClassification>,
): boolean {
  return columns.has(alias) || ['constructor', 'prototype'].includes(alias);
}
