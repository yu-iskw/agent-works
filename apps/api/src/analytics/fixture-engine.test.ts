import { describe, expect, it } from 'vitest';

import { compileMetric } from './compiler.js';
import { createFixtureEngine } from './fixture-engine.js';
import {
  analyticsDatasets,
  analyticsLimits,
  analyticsMetrics,
  analyticsPrincipal,
  analyticsRows,
  revenueQuery,
} from './fixtures.js';
import { guardSql } from './sql-guard.js';
const engine = createFixtureEngine(analyticsRows);
function query(sql: string) {
  const plan = { sql, params: {}, vetted: false, metric: null, classification: 'PUBLIC' as const };
  return {
    plan,
    guarded: guardSql(sql, {}, analyticsDatasets, analyticsPrincipal, analyticsLimits),
    maxBytes: 100000,
  };
}
describe('offline read-only fixture engine', () => {
  it('executes metric SQL over fixture groups', async () => {
    const plan = compileMetric(revenueQuery(), analyticsMetrics);
    const guarded = guardSql(
      plan.sql,
      plan.params,
      analyticsDatasets,
      analyticsPrincipal,
      analyticsLimits,
    );
    expect(await engine.execute({ plan, guarded, maxBytes: 100000 })).toEqual([
      { region: 'east', revenue: 40 },
      { region: 'west', revenue: 20 },
    ]);
  });
  it.each([
    ['SUM', 60],
    ['AVG', 20],
    ['MIN', 10],
    ['MAX', 30],
    ['COUNT', 3],
  ])('evaluates %s', async (fn, result) => {
    const input = query(
      `SELECT ${fn} (amount) AS value FROM approved.sales WHERE day >= '2026-10-01' LIMIT 20`,
    );
    expect(await engine.execute(input)).toEqual([{ value: result }]);
  });
  it('applies ordered limit after projection', async () => {
    expect(
      await engine.execute(
        query(
          "SELECT amount FROM approved.sales WHERE day >= '2026-10-01' ORDER BY amount DESC LIMIT 2",
        ),
      ),
    ).toEqual([{ amount: 30 }, { amount: 20 }]);
  });
  it('executes a partitioned equijoin', async () => {
    const input = query(
      "SELECT s.region, c.email FROM approved.sales AS s JOIN approved.customers AS c ON s.day = c.day WHERE s.day >= '2026-10-01' AND c.day >= '2026-10-01' ORDER BY region ASC LIMIT 20",
    );
    expect(await engine.execute(input)).toEqual([
      { region: 'east', email: 'alice@example.invalid' },
      { region: 'west', email: 'bob@example.invalid' },
    ]);
  });
  it('enforces maximum bytes again at execution', async () => {
    const input = query("SELECT amount FROM approved.sales WHERE day >= '2026-10-01' LIMIT 20");
    await expect(async () => engine.execute({ ...input, maxBytes: 511 })).rejects.toThrow(
      'ENGINE_BYTE_CAP',
    );
  });
  it('uses cloned fixture data', async () => {
    const fixtures = { ...structuredClone(analyticsRows) };
    const local = createFixtureEngine(fixtures);
    fixtures['approved.sales'] = [];
    expect(
      (
        await local.dryRun(
          query("SELECT amount FROM approved.sales WHERE day >= '2026-10-01' LIMIT 20"),
        )
      ).bytes,
    ).toBe(512);
  });
  it('returns NULL aggregate and zero count over empty groups', async () => {
    expect(
      await engine.execute(
        query(
          "SELECT SUM(amount) AS total, COUNT(amount) AS count FROM approved.sales WHERE day >= '2027-01-01' LIMIT 20",
        ),
      ),
    ).toEqual([{ total: null, count: 0 }]);
  });
  it.each([
    ['MIN', 'east'],
    ['MAX', 'west'],
  ])('allows %s on text columns and ignores NULL', async (fn, value) => {
    const local = createFixtureEngine({
      'approved.sales': [...analyticsRows['approved.sales'], { day: '2026-10-04', region: null }],
    });
    expect(
      await local.execute(
        query(
          `SELECT ${fn}(region) AS value FROM approved.sales WHERE day >= '2026-10-01' LIMIT 20`,
        ),
      ),
    ).toEqual([{ value }]);
  });
  it.each(['SUM', 'AVG'])('rejects %s on text columns', async (fn) => {
    await expect(async () =>
      engine.execute(
        query(
          `SELECT ${fn}(region) AS value FROM approved.sales WHERE day >= '2026-10-01' LIMIT 20`,
        ),
      ),
    ).rejects.toThrow('ENGINE_AGGREGATE');
  });
  it.each([
    ['MIN(region) AS value', '', [{ value: 'B' }]],
    ['MAX(region) AS value', '', [{ value: '\u{10000}' }]],
    [
      'region',
      'ORDER BY region ASC',
      ['B', 'a', 'e\u0301', 'é', '\uE000', '\u{10000}'].map((region) => ({ region })),
    ],
    ['region', "AND region < 'a'", [{ region: 'B' }]],
    ['region', "AND region = 'é'", [{ region: 'é' }]],
    ['region', "AND region = 'e\u0301'", [{ region: 'e\u0301' }]],
  ])('compares strings by code point for %s %s', async (projection, clause, expected) => {
    const local = createFixtureEngine({
      'approved.sales': ['a', 'B', 'é', 'e\u0301', '\u{10000}', '\uE000'].map((region) => ({
        day: '2026-10-01',
        region,
      })),
    });
    expect(
      await local.execute(
        query(
          `SELECT ${projection} FROM approved.sales WHERE day >= '2026-10-01' ${clause} LIMIT 20`,
        ),
      ),
    ).toEqual(expected);
  });
  it('efficiently groups large row sets within bounded time', async () => {
    const rowCount = 5000;
    const salesRows = Array.from({ length: rowCount }, (_, i) => ({
      day: '2026-10-01',
      region: `region-${i % 10}`,
      amount: 1,
    }));
    const local = createFixtureEngine(
      {
        'approved.sales': salesRows,
      },
      1,
    );
    const start = performance.now();
    const result = await local.execute(
      query(
        "SELECT region, SUM(amount) AS total FROM approved.sales WHERE day >= '2026-10-01' GROUP BY region LIMIT 20",
      ),
    );
    const elapsed = performance.now() - start;
    expect(result).toHaveLength(10);
    expect(elapsed).toBeLessThan(1000);
  });
});
