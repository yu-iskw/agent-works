import { describe, expect, it, vi } from 'vitest';

import { analyticsFixture, analyticsPrincipal } from './fixtures.js';
import { createAnalyticsService } from './service.js';
import { analyticsSiem } from './siem.js';

import type { EngineQuery } from '../ports/analytics.js';

describe('restricted result structure', () => {
  it.each([
    [
      "SELECT day FROM approved.customers WHERE day >= '2026-10-01' AND email >= @threshold LIMIT 20",
      'SQL_RESTRICTED_PREDICATE',
    ],
    [
      "SELECT 'constant' AS label FROM approved.customers WHERE day >= '2026-10-01' AND email >= @threshold LIMIT 20",
      'SQL_RESTRICTED_PREDICATE',
    ],
    [
      "SELECT day FROM approved.customers WHERE day >= '2026-10-01' AND day >= email LIMIT 20",
      'SQL_RESTRICTED_PREDICATE',
    ],
    [
      "SELECT day, MIN(day) AS n FROM approved.customers WHERE day >= '2026-10-01' AND email >= @threshold GROUP BY day LIMIT 20",
      'SQL_RESTRICTED_PREDICATE',
    ],
    [
      "SELECT MIN(day) AS n FROM approved.sales WHERE day >= '2026-10-01' GROUP BY customer_id LIMIT 20",
      'SQL_RESTRICTED_GROUP',
    ],
    [
      "SELECT customer_id, COUNT(*) AS n FROM approved.sales WHERE day >= '2026-10-01' GROUP BY customer_id LIMIT 20",
      'SQL_RESTRICTED_GROUP',
    ],
    [
      "SELECT MIN(day) AS n FROM approved.sales WHERE day >= '2026-10-01' GROUP BY region, customer_id LIMIT 20",
      'SQL_RESTRICTED_GROUP',
    ],
    [
      "SELECT s.day FROM approved.sales AS s JOIN approved.customers AS c ON s.customer_id = c.customer_id WHERE s.day >= '2026-10-01' AND c.day >= '2026-10-01' LIMIT 20",
      'SQL_RESTRICTED_PREDICATE',
    ],
    [
      "SELECT s.day FROM approved.sales AS s JOIN approved.customers AS c ON s.day = c.email WHERE s.day >= '2026-10-01' AND c.day >= '2026-10-01' LIMIT 20",
      'SQL_RESTRICTED_PREDICATE',
    ],
    [
      "SELECT MIN(s.day) AS n FROM approved.sales AS s JOIN approved.customers AS c ON c.email = s.day WHERE s.day >= '2026-10-01' AND c.day >= '2026-10-01' GROUP BY s.region LIMIT 20",
      'SQL_RESTRICTED_PREDICATE',
    ],
  ])('denies membership disclosure before querying: %s', async (sql, reason) => {
    const fixture = await analyticsFixture();
    const dryRun = vi.fn((query: EngineQuery) => fixture.engine.dryRun(query));
    const execute = vi.fn((query: EngineQuery) => fixture.engine.execute(query));
    const service = createAnalyticsService({ ...fixture, engine: { dryRun, execute } });
    for (const threshold of ['b', 'z']) {
      await expect(
        service.query(analyticsPrincipal, {
          kind: 'sql',
          sql,
          params: sql.includes('@threshold') ? { threshold } : {},
          limit: 20,
          maxBytes: 100000,
        }),
      ).rejects.toThrow(reason);
    }
    expect(dryRun).not.toHaveBeenCalled();
    expect(execute).not.toHaveBeenCalled();
    expect(await fixture.budget.port.events()).toEqual([]);
    const audits = await fixture.port.audits();
    expect(audits).toHaveLength(2);
    for (const audit of audits) {
      expect(audit).toMatchObject({
        outcome: 'denied',
        reason,
        estimatedBytes: null,
        columns: {},
        rows: [],
      });
      expect(analyticsSiem(audit).rows).toEqual([]);
    }
  });
});

describe('restricted ordering and limit lineage', () => {
  it.each([
    ['n ASC', 1],
    ['n DESC', 1],
    ['n ASC', 20],
    ['n DESC', 20],
    ['first_day ASC, n DESC', 1],
  ])('masks every output ordered by restricted counts: %s LIMIT %s', async (order, limit) => {
    const { service, port } = await analyticsFixture();
    const result = await service.query(analyticsPrincipal, {
      kind: 'sql',
      sql: `SELECT region, COUNT(*) AS n, MIN(day) AS first_day FROM approved.sales WHERE day >= '2026-10-01' GROUP BY region ORDER BY ${order} LIMIT ${limit}`,
      params: {},
      limit,
      maxBytes: 100000,
    });
    expect(result.columns).toEqual({
      region: 'RESTRICTED',
      n: 'RESTRICTED',
      first_day: 'RESTRICTED',
    });
    expect(result.rows).toEqual(
      Array.from({ length: Math.min(limit, 2) }, () => ({
        region: '[RESTRICTED]',
        n: '[RESTRICTED]',
        first_day: '[RESTRICTED]',
      })),
    );
    const audit = (await port.audits())[0];
    expect(audit.rows).toEqual(result.rows);
    expect(analyticsSiem(audit).rows).toEqual(result.rows);
  });

  it('masks readable columns selected by a restricted column alias', async () => {
    const { service, port } = await analyticsFixture();
    const result = await service.query(analyticsPrincipal, {
      kind: 'sql',
      sql: "SELECT day, email AS sort_key FROM approved.customers WHERE day >= '2026-10-01' ORDER BY sort_key DESC LIMIT 1",
      params: {},
      limit: 1,
      maxBytes: 100000,
    });
    expect(result.columns).toEqual({ day: 'RESTRICTED', sort_key: 'RESTRICTED' });
    expect(result.rows).toEqual([{ day: '[RESTRICTED]', sort_key: '[RESTRICTED]' }]);
    const audit = (await port.audits())[0];
    expect(audit.rows).toEqual(result.rows);
    expect(analyticsSiem(audit).rows).toEqual(result.rows);
  });

  it('preserves readable public grouping when a restricted aggregate does not control order', async () => {
    const { service } = await analyticsFixture();
    const result = await service.query(analyticsPrincipal, {
      kind: 'sql',
      sql: "SELECT region, COUNT(*) AS n FROM approved.sales WHERE day >= '2026-10-01' GROUP BY region ORDER BY region DESC LIMIT 1",
      params: {},
      limit: 1,
      maxBytes: 100000,
    });
    expect(result.columns).toEqual({ region: 'INTERNAL', n: 'RESTRICTED' });
    expect(result.rows).toEqual([{ region: 'west', n: '[RESTRICTED]' }]);
  });
});
