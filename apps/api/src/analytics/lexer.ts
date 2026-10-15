import { reject } from './errors.js';
import { unescapeString } from './parser-expression.js';
export type Token = { kind: 'word' | 'number' | 'string' | 'param' | 'symbol'; text: string };
/** No comments, quoted identifiers, raw/triple-quoted strings, scripting, or semicolons in the supported dialect. */
export function tokenize(sql: string): Token[] {
  if (Buffer.byteLength(sql) > 16384 || sql.length === 0) reject('SQL_SIZE');
  const tokens: Token[] = [];
  let offset = 0;
  while (offset < sql.length) {
    const tail = sql.slice(offset);
    const space = /^\s+/.exec(tail);
    if (space !== null) {
      offset += space[0].length;
      continue;
    }
    const found = scan(tail);
    if (found === undefined) reject('SQL_TOKEN');
    if (found.token.kind === 'string' && tokens.at(-1)?.kind === 'string') {
      reject('SQL_TOKEN');
    }
    tokens.push(found.token);
    offset += found.length;
    if (tokens.length > 2048) reject('SQL_COMPLEXITY');
  }
  return tokens;
}
function scan(tail: string): { token: Token; length: number } | undefined {
  const patterns: readonly [Token['kind'], RegExp][] = [
    ['string', /^'(?:[^'\\\r\n]|\\[^\r\n])*'|^"(?:[^"\\\r\n]|\\[^\r\n])*"/],
    ['param', /^@[a-z][a-z0-9_]*/],
    ['word', /^[A-Za-z_][A-Za-z0-9_]*/],
    ['number', /^-?\d+\.\d+/],
    ['number', /^-?\d+/],
    ['symbol', /^(?:>=|<=|[(),.=<>*])/],
  ];
  for (const [kind, pattern] of patterns) {
    const match = pattern.exec(tail);
    if (match !== null) {
      if (kind === 'string') unescapeString(match[0]);
      return { token: { kind, text: match[0] }, length: match[0].length };
    }
  }
  return undefined;
}
