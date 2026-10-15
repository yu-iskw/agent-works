import { describe, expect, it } from 'vitest';

import { parseSelect } from './parser.js';
describe('SELECT AST', () => {
  it('parses bounded aggregate SQL into explicit nodes', () => {
    const ast = parseSelect(
      'SELECT region, SUM(amount) AS revenue FROM approved.sales WHERE day >= @start GROUP BY region ORDER BY revenue DESC LIMIT 20',
    );
    expect(ast).toEqual({
      kind: 'select',
      projections: [
        { expression: { kind: 'column', table: null, name: 'region' }, alias: 'region' },
        {
          expression: {
            kind: 'aggregate',
            fn: 'SUM',
            column: { kind: 'column', table: null, name: 'amount' },
          },
          alias: 'revenue',
        },
      ],
      tables: [{ name: 'approved.sales', alias: 'sales' }],
      joins: [],
      filters: [
        {
          left: { kind: 'column', table: null, name: 'day' },
          op: '>=',
          right: { kind: 'param', name: 'start' },
        },
      ],
      groupBy: [{ kind: 'column', table: null, name: 'region' }],
      orderBy: [{ name: 'revenue', direction: 'DESC' }],
      limit: 20,
    });
  });
  it('does not tokenize SQL inside a string as code', () => {
    const ast = parseSelect(
      "SELECT 'DELETE FROM x; -- comment' AS label FROM approved.sales WHERE day = '2026-10-01' LIMIT 1",
    );
    expect(ast.projections[0].expression).toEqual({
      kind: 'literal',
      value: 'DELETE FROM x; -- comment',
    });
  });
  it('decodes valid GoogleSQL string escapes into literal values', () => {
    expect(
      parseSelect("SELECT 'it\\'s' AS label FROM approved.sales LIMIT 1").projections[0].expression,
    ).toEqual({ kind: 'literal', value: "it's" });
    expect(
      parseSelect('SELECT "it\'s" AS label FROM approved.sales LIMIT 1').projections[0].expression,
    ).toEqual({ kind: 'literal', value: "it's" });
    expect(
      parseSelect('SELECT "a \\"quoted\\" word" AS label FROM approved.sales LIMIT 1')
        .projections[0].expression,
    ).toEqual({ kind: 'literal', value: 'a "quoted" word' });
    expect(
      parseSelect(
        "SELECT '\\a\\b\\f\\n\\r\\t\\v\\\\\\?\\\"\\'\\`' AS label FROM approved.sales LIMIT 1",
      ).projections[0].expression,
    ).toEqual({ kind: 'literal', value: '\x07\b\f\n\r\t\v\\?"\'`' });
    expect(
      parseSelect("SELECT '\\101\\x42\\u03B1\\U0001F600' AS label FROM approved.sales LIMIT 1")
        .projections[0].expression,
    ).toEqual({ kind: 'literal', value: 'ABα😀' });
  });
  it.each([
    "SELECT '\\q' AS label FROM approved.sales LIMIT 1",
    "SELECT '\\07' AS label FROM approved.sales LIMIT 1",
    "SELECT '\\x4' AS label FROM approved.sales LIMIT 1",
    "SELECT '\\u123' AS label FROM approved.sales LIMIT 1",
    "SELECT '\\uD800' AS label FROM approved.sales LIMIT 1",
    "SELECT '\\U00110000' AS label FROM approved.sales LIMIT 1",
    "SELECT 'a\\\nb' AS label FROM approved.sales LIMIT 1",
  ])('rejects invalid string escape in %s', (sql) =>
    expect(() => parseSelect(sql)).toThrow('SQL_TOKEN'),
  );
  it.each([
    'SELECT',
    'SELECT region',
    'SELECT region FROM approved.sales',
    'SELECT * FROM approved.sales LIMIT 1',
    'SELECT SUM(amount) FROM approved.sales LIMIT 1',
  ])('rejects malformed or unsupported grammar: %s', (sql) =>
    expect(() => parseSelect(sql)).toThrow(),
  );
});
