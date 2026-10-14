import type { AnalyticsValue } from './domain.js';
export type Column = { kind: 'column'; table: string | null; name: string };
export type Expression =
  | Column
  | { kind: 'literal'; value: AnalyticsValue }
  | { kind: 'param'; name: string }
  | { kind: 'aggregate'; fn: 'SUM' | 'AVG' | 'COUNT' | 'MIN' | 'MAX'; column: Column | null };
export type Projection = { expression: Expression; alias: string };
export type Table = { name: string; alias: string };
export type Predicate = { left: Column; op: '=' | '>' | '<' | '>=' | '<='; right: Expression };
export type SelectAst = {
  kind: 'select';
  projections: Projection[];
  tables: Table[];
  joins: Predicate[];
  filters: Predicate[];
  groupBy: Column[];
  orderBy: { name: string; direction: 'ASC' | 'DESC' }[];
  limit: number;
};
