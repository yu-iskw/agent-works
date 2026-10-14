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
  it('preserves escaped apostrophes as literal values', () => {
    expect(
      parseSelect("SELECT 'it''s' AS label FROM approved.sales LIMIT 1").projections[0].expression,
    ).toEqual({ kind: 'literal', value: "it's" });
  });
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
