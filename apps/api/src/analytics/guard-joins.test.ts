import { describe, expect, it } from 'vitest';

import { analyticsDatasets, analyticsLimits, analyticsPrincipal } from './fixtures.js';
import { guardSql } from './sql-guard.js';
const sql =
  "SELECT s.region, c.email FROM approved.sales AS s JOIN approved.customers AS c ON s.day = c.day WHERE s.day >= '2026-10-01' AND c.day >= '2026-10-01' LIMIT 20";
function guard(input: string) {
  return guardSql(input, {}, analyticsDatasets, analyticsPrincipal, analyticsLimits);
}
describe('bounded equijoins', () => {
  it('allows an approved equijoin with both partitions', () =>
    expect(guard(sql).columns).toEqual({ region: 'INTERNAL', email: 'RESTRICTED' }));
  it('requires both partition filters', () =>
    expect(() => guard(sql.replace(" AND c.day >= '2026-10-01'", ''))).toThrow(
      'SQL_PARTITION_REQUIRED',
    ));
  it('rejects ambiguous unqualified columns', () =>
    expect(() => guard(sql.replace('s.region, c.email', 'day'))).toThrow('COLUMN_NOT_ALLOWED'));
  it('rejects an unrelated join condition', () =>
    expect(() => guard(sql.replace('s.day = c.day', 's.day = s.day'))).toThrow('SQL_JOIN'));
  it('enforces configured join cap', () =>
    expect(() =>
      guardSql(sql, {}, analyticsDatasets, analyticsPrincipal, { ...analyticsLimits, maxJoins: 0 }),
    ).toThrow('SQL_JOIN_CAP'));
  it('rejects undeclared aliases', () =>
    expect(() => guard(sql.replace('c.email', 'x.email'))).toThrow('COLUMN_NOT_ALLOWED'));
  it('denies a missing grant on the joined dataset', () =>
    expect(() =>
      guardSql(
        sql,
        {},
        analyticsDatasets,
        { ...analyticsPrincipal, datasets: ['approved.sales'] },
        analyticsLimits,
      ),
    ).toThrow('DATASET_FORBIDDEN'));
});
