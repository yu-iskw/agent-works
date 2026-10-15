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
const escapeKeys = 'abfnrtv\\?"\'`';
const escapeVals = '\x07\b\f\n\r\t\v\\?"\'`';
export function unescapeString(raw: string): string {
  return raw
    .slice(1, -1)
    .replace(
      /\\([abfnrtv\\?"'`]|[0-7]{3}|x[0-9a-fA-F]{2}|u[0-9a-fA-F]{4}|U[0-9a-fA-F]{8}|[\s\S])/g,
      (_match, esc: string) => {
        const idx = escapeKeys.indexOf(esc);
        if (idx !== -1) return escapeVals.charAt(idx);
        if (esc.length === 1) reject('SQL_TOKEN');
        const cp = Number.parseInt(esc[0] <= '7' ? esc : esc.slice(1), esc[0] <= '7' ? 8 : 16);
        if (cp === 0 || cp > 0x10ffff || (cp >= 0xd800 && cp <= 0xdfff)) reject('SQL_TOKEN');
        return String.fromCodePoint(cp);
      },
    );
}
export function expression(cursor: Cursor): Expression {
  const token = cursor.take();
  if (token.kind === 'param') return { kind: 'param', name: token.text.slice(1) };
  if (token.kind === 'string') return { kind: 'literal', value: unescapeString(token.text) };
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
