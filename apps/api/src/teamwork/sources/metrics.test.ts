import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { createFixtureSources } from './fixture.js';

import type { MetricsScope } from '@agent-works/domain/teamwork';
import type postgres from 'postgres';

type Expected = {
  expected: Record<
    string,
    {
      metric: string;
      region?: string;
      channel?: string;
      baselineValue: number;
      currentValue: number;
      changePct: number;
    }[]
  >;
  tolerance: { absolute: number; percentPoints: number };
};

const root = new URL('../../../../../', import.meta.url).pathname;

/**
 * The workbench's deterministic calculations must match the expected-answer manifest, which
 * scripts/m1/seed-data.mjs computes independently from the same seed rows.
 */
describe.each(['alpha', 'beta'])('metric calculations for %s', (segment) => {
  const manifest = JSON.parse(
    // eslint-disable-next-line security/detect-non-literal-fs-filename
    readFileSync(`${root}fixtures/m1/expected/${segment}-metrics.json`, 'utf8'),
  ) as Expected;
  const sources = createFixtureSources({
    root,
    segment,
    sql: undefined as unknown as postgres.Sql,
    faults: false,
  });
  it.each(Object.entries(manifest.expected))('%s', async (key, rows) => {
    const [groupBy, periods] = key.split(':') as ['region' | 'channel', string];
    const [baseline = '', current = ''] = periods.split('->');
    const scope: MetricsScope = { baseline, current, groupBy };
    const result = await sources.read({
      kind: 'bigquery_metrics',
      token: () => Promise.resolve('x'),
      query: '',
      metrics: scope,
      repository: null,
      issueNumber: null,
    });
    const calcs = result.metrics?.calculations ?? [];
    for (const row of rows) {
      const group = groupBy === 'region' ? row.region : row.channel;
      const calc = calcs.find((c) => c.metric === row.metric && c.group === group);
      expect(calc, `${row.metric} ${group}`).toBeDefined();
      expect(Math.abs((calc?.baselineValue ?? 0) - row.baselineValue)).toBeLessThanOrEqual(
        manifest.tolerance.absolute,
      );
      expect(Math.abs((calc?.currentValue ?? 0) - row.currentValue)).toBeLessThanOrEqual(
        manifest.tolerance.absolute,
      );
      expect(Math.abs((calc?.changePct ?? 0) - row.changePct)).toBeLessThanOrEqual(
        manifest.tolerance.percentPoints,
      );
    }
  });
});
