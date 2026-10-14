import { reject } from './errors.js';
import { tokenize } from './lexer.js';
import { Cursor } from './parser-cursor.js';
import { column, expression, predicate } from './parser-expression.js';

import type { Projection, SelectAst, Table } from './ast.js';
function table(cursor: Cursor): Table {
  const dataset = cursor.identifier();
  cursor.expect('.');
  const name = cursor.identifier();
  const alias = cursor.consume('AS') ? cursor.identifier() : name;
  return { name: `${dataset}.${name}`, alias };
}
function projections(cursor: Cursor): Projection[] {
  const values: Projection[] = [];
  do {
    const value = expression(cursor);
    const alias = cursor.consume('AS')
      ? cursor.identifier()
      : value.kind === 'column'
        ? value.name
        : reject('SQL_ALIAS_REQUIRED');
    values.push({ expression: value, alias });
    if (values.length > 64) reject('SQL_PROJECTIONS');
  } while (cursor.consume(','));
  return values;
}
function from(cursor: Cursor, ast: SelectAst): void {
  cursor.expect('FROM');
  ast.tables.push(table(cursor));
  while (cursor.consume('JOIN')) {
    ast.tables.push(table(cursor));
    cursor.expect('ON');
    ast.joins.push(predicate(cursor, true));
    if (ast.joins.length > 4) reject('SQL_JOIN_CAP');
  }
  if (cursor.consume('WHERE'))
    do {
      ast.filters.push(predicate(cursor));
    } while (cursor.consume('AND'));
}
function grouping(cursor: Cursor, ast: SelectAst): void {
  if (cursor.consume('GROUP')) {
    cursor.expect('BY');
    do {
      ast.groupBy.push(column(cursor));
    } while (cursor.consume(','));
  }
  if (cursor.consume('ORDER')) {
    cursor.expect('BY');
    do {
      ast.orderBy.push({ name: cursor.identifier(), direction: direction(cursor) });
    } while (cursor.consume(','));
  }
}
function direction(cursor: Cursor): 'ASC' | 'DESC' {
  if (cursor.consume('DESC')) return 'DESC';
  cursor.consume('ASC');
  return 'ASC';
}
export function parseSelect(sql: string): SelectAst {
  const cursor = new Cursor(tokenize(sql));
  cursor.expect('SELECT');
  const ast: SelectAst = {
    kind: 'select',
    projections: projections(cursor),
    tables: [],
    joins: [],
    filters: [],
    groupBy: [],
    orderBy: [],
    limit: 0,
  };
  from(cursor, ast);
  grouping(cursor, ast);
  cursor.expect('LIMIT');
  const limit = cursor.take();
  if (limit.kind !== 'number' || !/^\d+$/.test(limit.text)) reject('SQL_LIMIT');
  ast.limit = Number(limit.text);
  if (!cursor.done()) reject('SQL_TRAILING');
  return ast;
}
