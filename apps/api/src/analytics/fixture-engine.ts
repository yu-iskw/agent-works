import { compare, evaluate, scalar } from './engine-expression.js';
import { reject } from './errors.js';
import { checkAnalyticsExecution } from './execution.js';

import type { Predicate } from './ast.js';
import type { AnalyticsRow } from './domain.js';
import type { JoinedRow } from './engine-expression.js';
import type { EngineQuery, QueryEngine } from '../ports/analytics.js';
export function createFixtureEngine(
  input: Readonly<Record<string, readonly AnalyticsRow[]>>,
  bytesPerRow = 128,
): QueryEngine {
  const fixtures = new Map(Object.entries(structuredClone(input)));
  function estimate(query: EngineQuery): number {
    checkAnalyticsExecution(query.execution);
    return query.guarded.ast.tables.reduce(
      (bytes, t) =>
        bytes + (fixtures.get(t.name)?.length ?? reject('ENGINE_DATASET')) * bytesPerRow,
      0,
    );
  }
  return {
    dryRun: (query) => Promise.resolve({ bytes: estimate(query) }),
    execute(query) {
      if (estimate(query) > query.maxBytes) reject('ENGINE_BYTE_CAP', 422);
      const rows = joinRows(query, fixtures).filter((r) =>
        query.guarded.ast.filters.every((p) => matches(p, r, query)),
      );
      const output = project(rows, query);
      output.sort((a, b) => {
        for (const sort of query.guarded.ast.orderBy) {
          const order = compare(a[sort.name], b[sort.name]);
          if (order !== 0) return sort.direction === 'ASC' ? order : -order;
        }
        return 0;
      });
      return Promise.resolve(output.slice(0, query.guarded.ast.limit));
    },
  };
}
function matches(p: Predicate, row: JoinedRow, query: EngineQuery): boolean {
  const a = scalar(p.left, row, query.plan.params, query.guarded);
  const b = scalar(p.right, row, query.plan.params, query.guarded);
  if (a === null || b === null || typeof a !== typeof b) return false;
  const order = compare(a, b);
  switch (p.op) {
    case '=':
      return order === 0;
    case '>':
      return order > 0;
    case '<':
      return order < 0;
    case '>=':
      return order >= 0;
    case '<=':
      return order <= 0;
  }
}
function joinRows(
  query: EngineQuery,
  fixtures: ReadonlyMap<string, readonly AnalyticsRow[]>,
): JoinedRow[] {
  let rows: JoinedRow[] = [new Map()];
  for (const [index, table] of query.guarded.ast.tables.entries()) {
    const next: JoinedRow[] = [];
    const source = fixtures.get(table.name) ?? reject('ENGINE_DATASET');
    if (rows.length * source.length > 100000) reject('ENGINE_JOIN_CAP', 422);
    for (const row of rows)
      for (const item of source) {
        const joined = new Map(row);
        joined.set(table.alias, item);
        if (index === 0 || matches(query.guarded.ast.joins[index - 1], joined, query))
          next.push(joined);
      }
    rows = next;
  }
  return rows;
}
function project(rows: JoinedRow[], query: EngineQuery): AnalyticsRow[] {
  const ast = query.guarded.ast;
  const aggregate = ast.projections.some((p) => p.expression.kind === 'aggregate');
  let groups: JoinedRow[][];
  if (!aggregate) groups = rows.map((r) => [r]);
  else if (ast.groupBy.length === 0) groups = [rows];
  else {
    const grouped = new Map<string, JoinedRow[]>();
    for (const row of rows) {
      const key = JSON.stringify(
        ast.groupBy.map((c) => scalar(c, row, query.plan.params, query.guarded)),
      );
      const group = grouped.get(key);
      if (group === undefined) {
        grouped.set(key, [row]);
      } else {
        group.push(row);
      }
    }
    groups = [...grouped.values()];
  }
  return groups.map((group) =>
    Object.fromEntries(
      ast.projections.map((p) => [
        p.alias,
        evaluate(p.expression, group, query.plan.params, query.guarded),
      ]),
    ),
  );
}
