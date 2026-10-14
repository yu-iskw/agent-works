/* eslint-disable security/detect-non-literal-fs-filename -- reads fixed checked-in analytics acceptance fixtures only */
import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { analyticsDatasets, analyticsLimits, analyticsPrincipal } from './fixtures.js';
import { guardSql } from './sql-guard.js';

import type { AnalyticsParams } from './domain.js';
type Case = { id: string; sql: string; params: AnalyticsParams; category: string };
const categories = [
  'writes',
  'scripts',
  'comments',
  'tables',
  'columns',
  'bounds',
  'encoding',
  'functions',
];
const cases = categories.flatMap((category) => {
  return JSON.parse(
    readFileSync(
      new URL(`../../../../evals/fixtures/analytics-hostile-${category}.json`, import.meta.url),
      'utf8',
    ),
  ) as Case[];
});
describe('hostile SQL acceptance corpus', () => {
  it('contains at least one hundred distinct attacks', () => {
    expect(cases.length).toBeGreaterThanOrEqual(100);
    expect(new Set(cases.map((c) => c.sql)).size).toBe(cases.length);
  });
  it.each(cases)('rejects $id ($category)', ({ sql, params }) => {
    expect(() =>
      guardSql(sql, params, analyticsDatasets, analyticsPrincipal, analyticsLimits),
    ).toThrow();
  });
});
