import { describe, expect, it } from 'vitest';

import { tokenize } from './lexer.js';
describe('bounded SQL lexer', () => {
  it('recognizes identifiers, parameters and operators', () => {
    expect(tokenize('day >= @start')).toEqual([
      { kind: 'word', text: 'day' },
      { kind: 'symbol', text: '>=' },
      { kind: 'param', text: '@start' },
    ]);
  });
  it('recognizes valid GoogleSQL string escapes in single and double quotes', () => {
    expect(tokenize("'O\\'Reilly'")).toEqual([{ kind: 'string', text: "'O\\'Reilly'" }]);
    expect(tokenize('"O\'Reilly"')).toEqual([{ kind: 'string', text: '"O\'Reilly"' }]);
    expect(tokenize('"a \\"quoted\\" word"')).toEqual([
      { kind: 'string', text: '"a \\"quoted\\" word"' },
    ]);
    expect(tokenize("'\\a\\b\\f\\n\\r\\t\\v\\\\\\?\\\"\\'\\`'")).toEqual([
      { kind: 'string', text: "'\\a\\b\\f\\n\\r\\t\\v\\\\\\?\\\"\\'\\`'" },
    ]);
    expect(tokenize("'\\101\\x41\\u0041\\U0001F600'")).toEqual([
      { kind: 'string', text: "'\\101\\x41\\u0041\\U0001F600'" },
    ]);
  });
  it.each([
    ';',
    '-- x',
    '/* x */',
    '`x`',
    '\u0000',
    "'unterminated",
    "'O''Reilly'",
    "'a' 'b'",
    '"unterminated',
    "'a\\\nb'",
    "'a\\\rb'",
    '"a\\\nb"',
    '"a\\\rb"',
    "'back\\slash'",
    "'\\q'",
    "'\\07'",
    "'\\078'",
    "'\\800'",
    "'\\x4'",
    "'\\xGG'",
    "'\\X41'",
    "'\\000'",
    "'\\x00'",
    "'\\u0000'",
    "'\\U00000000'",
    "'\\u123'",
    "'\\uD800'",
    "'\\uDFFF'",
    "'\\U0001F60'",
    "'\\U0000D800'",
    "'\\U00110000'",
  ])('rejects unsupported token %j', (sql) => expect(() => tokenize(sql)).toThrow('SQL_TOKEN'));
  it('enforces bytes before tokenization', () =>
    expect(() => tokenize('é'.repeat(10000))).toThrow('SQL_SIZE'));
  it('enforces the token cap', () =>
    expect(() => tokenize('x '.repeat(2049))).toThrow('SQL_COMPLEXITY'));
});
