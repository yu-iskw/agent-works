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
  it.each([';', '-- x', '/* x */', '`x`', '"x"', '\u0000', "'unterminated", "'back\\slash'"])(
    'rejects unsupported token %j',
    (sql) => expect(() => tokenize(sql)).toThrow('SQL_TOKEN'),
  );
  it('enforces bytes before tokenization', () =>
    expect(() => tokenize('é'.repeat(10000))).toThrow('SQL_SIZE'));
  it('enforces the token cap', () =>
    expect(() => tokenize('x '.repeat(2049))).toThrow('SQL_COMPLEXITY'));
});
