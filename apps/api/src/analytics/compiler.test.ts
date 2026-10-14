import { describe, expect, it } from 'vitest';

import { compileMetric } from './compiler.js';
import {
  analyticsDatasets,
  analyticsLimits,
  analyticsPrincipal,
  analyticsMetrics,
  revenueQuery,
} from './fixtures.js';
import { guardSql } from './sql-guard.js';

describe('vetted metric compiler', () => {
  it('binds filter values without putting them into SQL', () => {
    const q = revenueQuery();
    if (q.kind !== 'metric') throw new Error('fixture');
    q.filters.push({ column: 'region', op: '=', value: "east'; DROP TABLE approved.sales; --" });
    const plan = compileMetric(q, analyticsMetrics);
    expect(plan.sql).toContain('region = @filter_1');
    expect(plan.sql).not.toContain('DROP');
    expect(plan.params.filter_1).toContain('DROP');
    expect(plan.vetted).toBe(true);
  });
  it.each(analyticsMetrics)('compiles approved metric $name', (m) => {
    const q = revenueQuery();
    if (q.kind !== 'metric') throw new Error('fixture');
    const plan = compileMetric({ ...q, metric: m.name }, analyticsMetrics);
    expect(plan.metric).toBe(m.name);
    expect(plan.sql).not.toContain('{{');
  });
  it.each([['secret'], ['region', 'region']].map((dimensions) => ({ dimensions })))(
    'rejects unapproved dimensions $dimensions',
    ({ dimensions }) => {
      const q = revenueQuery();
      if (q.kind !== 'metric') throw new Error('fixture');
      expect(() => compileMetric({ ...q, dimensions }, analyticsMetrics)).toThrow(
        'METRIC_DIMENSION',
      );
    },
  );
  it('rejects missing metric', () => {
    const q = revenueQuery();
    if (q.kind !== 'metric') throw new Error('fixture');
    expect(() => compileMetric({ ...q, metric: 'unknown' }, analyticsMetrics)).toThrow(
      'METRIC_NOT_FOUND',
    );
  });
  it('marks free SQL as unvetted', () => {
    expect(
      compileMetric(
        { kind: 'sql', sql: 'SELECT x', params: {}, maxBytes: 100, limit: 1 },
        analyticsMetrics,
      ).vetted,
    ).toBe(false);
  });
});

// Vetted metric corpus covers every approved dimension combination and grain.
describe('approved semantic metric SQL corpus', () => {
  const cases = analyticsMetrics.flatMap((metric) =>
    [[], ['region'], ['day'], ['region', 'day']].map((dimensions) => ({ metric, dimensions })),
  );
  it.each(cases)('accepts $metric.name with $dimensions', ({ metric, dimensions }) => {
    const request = revenueQuery();
    if (request.kind !== 'metric') throw new Error('fixture');
    const plan = compileMetric({ ...request, metric: metric.name, dimensions }, analyticsMetrics);
    expect(
      guardSql(plan.sql, plan.params, analyticsDatasets, analyticsPrincipal, analyticsLimits).ast
        .kind,
    ).toBe('select');
  });
});

describe('metric template administration defenses', () => {
  it('rejects a metric template referencing a different declared dataset', () => {
    const metric = analyticsMetrics[0];
    expect(() =>
      compileMetric(revenueQuery(), [
        {
          ...metric,
          sqlTemplate: metric.sqlTemplate.replace('approved.sales', 'approved.customers'),
        },
      ]),
    ).toThrow('METRIC_DATASET');
  });
  it('rejects an unresolved template marker', () => {
    const metric = analyticsMetrics[0];
    expect(() =>
      compileMetric(revenueQuery(), [
        { ...metric, sqlTemplate: `${metric.sqlTemplate} {{unknown}}` },
      ]),
    ).toThrow('METRIC_TEMPLATE');
  });
  it.each(['{{filters}}', '{{limit}}'])('requires the %s safety placeholder', (marker) => {
    const metric = analyticsMetrics[0];
    expect(() =>
      compileMetric(revenueQuery(), [
        { ...metric, sqlTemplate: metric.sqlTemplate.replace(marker, '1') },
      ]),
    ).toThrow('METRIC_TEMPLATE');
  });
  it('does not silently convert a raw projection into a vetted metric', () => {
    const metric = analyticsMetrics[0];
    expect(() =>
      compileMetric(revenueQuery(), [
        {
          ...metric,
          sqlTemplate: 'SELECT region FROM approved.sales WHERE {{filters}} LIMIT {{limit}}',
        },
      ]),
    ).toThrow('METRIC_DATASET');
  });
  it('requires a filter set before rendering semantic SQL', () => {
    const request = revenueQuery();
    if (request.kind !== 'metric') throw new Error('fixture');
    expect(() => compileMetric({ ...request, filters: [] }, analyticsMetrics)).toThrow(
      'METRIC_FILTER_REQUIRED',
    );
  });
});
