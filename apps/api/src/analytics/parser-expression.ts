import { reject } from './errors.js';

import type { Column, Expression, Predicate } from './ast.js';
import type { Cursor } from './parser-cursor.js';
const aggregates = new Set(['SUM', 'AVG', 'COUNT', 'MIN', 'MAX']);
export function column(cursor: Cursor): Column {
  const first = cursor.identifier();
  return cursor.consume('.')
    ? { kind: 'column', table: first, name: cursor.identifier() }
    : { kind: 'column', table: null, name: first };
}
export function expression(cursor: Cursor): Expression {
  const token = cursor.take();
  if (token.kind === 'param') return { kind: 'param', name: token.text.slice(1) };
  if (token.kind === 'string')
    return { kind: 'literal', value: token.text.slice(1, -1).replaceAll("''", "'") };
  if (token.kind === 'number') return numeric(token.text);
  if (token.kind !== 'word') reject('SQL_EXPRESSION');
  const fn = token.text.toUpperCase();
  if (aggregates.has(fn) && cursor.consume('(')) {
    const arg = fn === 'COUNT' && cursor.consume('*') ? null : column(cursor);
    cursor.expect(')');
    return { kind: 'aggregate', fn: fn as 'SUM' | 'AVG' | 'COUNT' | 'MIN' | 'MAX', column: arg };
  }
  if (!/^[a-z][a-z0-9_]{0,63}$/.test(token.text)) reject('SQL_IDENTIFIER');
  return cursor.consume('.')
    ? { kind: 'column', table: token.text, name: cursor.identifier() }
    : { kind: 'column', table: null, name: token.text };
}
export function predicate(cursor: Cursor, join = false): Predicate {
  const left = column(cursor);
  const op = cursor.take().text;
  if (!['=', '>', '<', '>=', '<='].includes(op)) reject('SQL_OPERATOR');
  const right = expression(cursor);
  if (right.kind === 'aggregate') reject('SQL_PREDICATE');
  if (join && (op !== '=' || right.kind !== 'column')) reject('SQL_JOIN');
  return { left, op: op as Predicate['op'], right };
}

function numeric(text: string): Expression {
  const value = Number(text);
  if (!Number.isFinite(value)) reject('SQL_NUMBER');
  return { kind: 'literal', value };
}
