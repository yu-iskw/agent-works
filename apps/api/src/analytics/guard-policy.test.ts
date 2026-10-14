import { describe, expect, it } from 'vitest';

import { analyticsDatasets, analyticsLimits, analyticsPrincipal } from './fixtures.js';
import { guardSql } from './sql-guard.js';
const sql = "SELECT region FROM approved.sales WHERE day >= '2026-10-01' LIMIT 20";
function guard(input: string) {
  return guardSql(input, {}, analyticsDatasets, analyticsPrincipal, analyticsLimits);
}
describe('column, dataset and partition policies', () => {
  it('accepts approved select and inherits source classification', () =>
    expect(guard(sql).columns).toEqual({ region: 'INTERNAL' }));
  it('denies missing dataset grant', () =>
    expect(() =>
      guardSql(
        sql,
        {},
        analyticsDatasets,
        { ...analyticsPrincipal, datasets: [] },
        analyticsLimits,
      ),
    ).toThrow('DATASET_FORBIDDEN'));
  it.each([[], ['Admin'], ['ANALYST'], ['Employee']].map((roles) => ({ roles })))(
    'denies untrusted role $roles',
    ({ roles }) =>
      expect(() =>
        guardSql(sql, {}, analyticsDatasets, { ...analyticsPrincipal, roles }, analyticsLimits),
      ).toThrow('FORBIDDEN'),
  );
  it('classifies a restricted alias from its source', () =>
    expect(guard(sql.replace('region FROM', 'customer_id AS public_name FROM')).columns).toEqual({
      public_name: 'RESTRICTED',
    }));
  it('classifies aggregates without downgrading', () =>
    expect(
      guard(sql.replace('region FROM', 'COUNT(customer_id) AS count FROM')).columns.count,
    ).toBe('RESTRICTED'));
  it('requires grouping for mixed aggregates', () =>
    expect(() => guard(sql.replace('region FROM', 'region, SUM(amount) AS total FROM'))).toThrow(
      'SQL_GROUP',
    ));
  it('rejects sort by unselected sensitive column', () =>
    expect(() => guard(sql.replace('LIMIT', 'ORDER BY customer_id LIMIT'))).toThrow('SQL_ORDER'));
  it('rejects unallowlisted filter column', () =>
    expect(() => guard(sql.replace('LIMIT', "AND secret = 'x' LIMIT"))).toThrow(
      'COLUMN_NOT_ALLOWED',
    ));
  it('rejects unallowlisted group column', () =>
    expect(() =>
      guard(
        sql
          .replace('region FROM', 'SUM(amount) AS total FROM')
          .replace('LIMIT', 'GROUP BY secret LIMIT'),
      ),
    ).toThrow('COLUMN_NOT_ALLOWED'));
  it('rejects unused bindings', () =>
    expect(() =>
      guardSql(sql, { unused: 'x' }, analyticsDatasets, analyticsPrincipal, analyticsLimits),
    ).toThrow('SQL_PARAMS'));
  it('rejects missing bindings', () =>
    expect(() =>
      guardSql(
        sql.replace("'2026-10-01'", '@start'),
        {},
        analyticsDatasets,
        analyticsPrincipal,
        analyticsLimits,
      ),
    ).toThrow('SQL_PARAMS'));
  it('accepts parameterized partition predicate', () =>
    expect(
      guardSql(
        sql.replace("'2026-10-01'", '@start'),
        { start: '2026-10-01' },
        analyticsDatasets,
        analyticsPrincipal,
        analyticsLimits,
      ).ast.limit,
    ).toBe(20));
});

describe('strict calendar partition bounds', () => {
  it.each([
    '2026-02-30',
    '2026-02-29',
    '2026-04-31',
    '2026-13-01',
    '2026-00-01',
    '2026-10-00',
    '2026-1-1',
    '2026-10-01T00:00:00Z',
  ])('rejects invalid date %s', (date) => {
    expect(() => guard(sql.replace('2026-10-01', date))).toThrow('SQL_PARTITION_REQUIRED');
  });
  it('accepts leap day in a leap year', () => {
    expect(guard(sql.replace('2026-10-01', '2028-02-29')).ast.limit).toBe(20);
  });
  it('applies a configured stricter row ceiling', () => {
    expect(() =>
      guardSql(sql, {}, analyticsDatasets, analyticsPrincipal, { ...analyticsLimits, maxRows: 19 }),
    ).toThrow('SQL_LIMIT_CAP');
  });
  it('inherits the explicit metric classification floor', () => {
    expect(
      guardSql(sql, {}, analyticsDatasets, analyticsPrincipal, {
        ...analyticsLimits,
        floor: 'RESTRICTED',
      }).columns.region,
    ).toBe('RESTRICTED');
  });
});
