import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { costReport, priceTableSchema, trafficSchema } from './model.js';
import { reconcileProviderUsage } from './provider-usage.js';

const fixture = JSON.parse(
  // eslint-disable-next-line security/detect-non-literal-fs-filename
  readFileSync(new URL('../../../../tools/finops/fixtures/traffic.json', import.meta.url), 'utf8'),
) as { traffic: unknown; prices: unknown };
const traffic = trafficSchema.parse(fixture.traffic);
const prices = priceTableSchema.parse(fixture.prices);
describe('RFC capacity formula and full accepted-result cost', () => {
  it('produces a deterministic cost report (snapshot)', () => {
    expect(costReport(traffic, prices)).toMatchSnapshot();
  });
  it('adds direct and labor rows and uses completed and accepted denominators', () => {
    const report = costReport(traffic, prices);
    expect(report.directMicros).toBe(
      report.direct.reduce((sum, row) => sum + row.estimatedMicros, 0),
    );
    expect(report.totalMicros).toBe(report.directMicros + report.laborMicros);
    expect(report.perAcceptedMicros).toBe(Math.round(report.totalMicros / report.accepted));
    expect(report.perCompletedMicros).toBe(Math.round(report.totalMicros / report.completed));
    expect(report.perAcceptedMicros).toBeGreaterThan(report.perCompletedMicros ?? 0);
  });
  it('reports no denominator for zero accepted or completed results', () => {
    const report = costReport({ ...traffic, completionRatio: 0 }, prices);
    expect(report.perAcceptedMicros).toBeNull();
    expect(report.perCompletedMicros).toBeNull();
  });
  it('isolates cache and peak factor effects', () => {
    const report = costReport({ ...traffic, cacheRatio: 1, peakFactor: 100 }, prices);
    expect(report.direct.find((row) => row.component === 'model_input')?.estimatedMicros).toBe(0);
    expect(report.capacity.peakConcurrentJobs).toBeGreaterThan(
      costReport(traffic, prices).capacity.peakConcurrentJobs,
    );
  });
  it('rejects unmarked prices and invalid traffic', () => {
    expect(() =>
      costReport(traffic, { ...prices, approval: 'approved' } as unknown as typeof prices),
    ).toThrow();
    expect(() => costReport({ ...traffic, cacheRatio: 2 }, prices)).toThrow();
    expect(() => costReport(traffic, { ...prices, inputTokenMicros: Infinity })).toThrow();
  });
  it('preserves provider estimate variance for one tagged non-production task', () => {
    const report = reconcileProviderUsage([
      {
        approval: 'PLACEHOLDER',
        taskId: 'fixture-task',
        sponsor: 'platform',
        estimatedCostMicros: 100,
        providerUsageMicros: 110,
      },
    ]);
    expect(report.varianceMicros).toBe(10);
    expect(report.rows[0].sponsor).toBe('platform');
    expect(() => reconcileProviderUsage([...report.rows, ...report.rows])).toThrow();
  });
});
