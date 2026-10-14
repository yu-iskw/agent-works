import { describe, expect, it, vi } from 'vitest';

import { analyticsHash } from './domain.js';
import {
  analyticsDatasets,
  analyticsFixture,
  analyticsLimits,
  analyticsPrincipal,
} from './fixtures.js';
import { createAnalyticsService } from './service.js';
import { analyticsSiem } from './siem.js';
import { guardSql } from './sql-guard.js';

describe('analytics predicate and evidence privacy', () => {
  it.each([
    ['MIN(day)', 'customers', 'email'],
    ['MAX(day)', 'customers', 'email'],
    ['MIN(day)', 'sales', 'customer_id'],
    ['MAX(day)', 'sales', 'customer_id'],
    ['SUM(amount)', 'sales', 'customer_id'],
    ['AVG(amount)', 'sales', 'customer_id'],
  ])(
    'masks %s on %s for both matching and empty restricted predicates',
    async (expression, table, predicate) => {
      const { service, port } = await analyticsFixture();
      for (const threshold of ['b', 'z']) {
        const result = await service.query(analyticsPrincipal, {
          kind: 'sql',
          sql: `SELECT ${expression} AS n FROM approved.${table} WHERE day >= '2026-10-01' AND ${predicate} >= @threshold LIMIT 20`,
          params: { threshold },
          limit: 20,
          maxBytes: 100000,
        });
        expect(result.columns).toEqual({ n: 'RESTRICTED' });
        expect(result.rows).toEqual([{ n: '[RESTRICTED]' }]);
      }
      for (const audit of await port.audits()) {
        expect(audit.rows).toEqual([{ n: '[RESTRICTED]' }]);
        expect(analyticsSiem(audit).rows).toEqual(audit.rows);
      }
    },
  );

  it.each([
    "SELECT MIN(day) AS n FROM approved.customers WHERE day >= '2026-10-01' AND email >= 'b' LIMIT 20",
    "SELECT MIN(day) AS n FROM approved.customers WHERE day >= '2026-10-01' AND day >= email LIMIT 20",
    "SELECT MIN(s.day) AS n FROM approved.sales AS s JOIN approved.customers AS c ON s.day = c.email WHERE s.day >= '2026-10-01' AND c.day >= '2026-10-01' LIMIT 20",
    "SELECT MIN(s.day) AS n FROM approved.sales AS s JOIN approved.customers AS c ON c.email = s.day WHERE s.day >= '2026-10-01' AND c.day >= '2026-10-01' LIMIT 20",
  ])('propagates restricted lineage from either predicate operand: %s', (sql) => {
    expect(
      guardSql(sql, {}, analyticsDatasets, analyticsPrincipal, analyticsLimits).columns,
    ).toEqual({ n: 'RESTRICTED' });
  });

  it('redacts parameter and literal projections before persistence while preserving results', async () => {
    const fixture = await analyticsFixture();
    const audit = vi.fn((event: Parameters<typeof fixture.port.audit>[0]) =>
      fixture.port.audit(event),
    );
    const service = createAnalyticsService({ ...fixture, port: { ...fixture.port, audit } });
    const params = { secret: 'private-binding', number: 987654, flag: true, empty: null };
    const result = await service.query(analyticsPrincipal, {
      kind: 'sql',
      sql: "SELECT @secret AS label, @number AS number, @flag AS flag, @empty AS empty, 'private-literal' AS text, 123456 AS numeric, day FROM approved.sales WHERE day >= '2026-10-01' LIMIT 1",
      params,
      limit: 1,
      maxBytes: 100000,
    });
    expect(result.rows).toEqual([
      {
        label: params.secret,
        number: params.number,
        flag: true,
        empty: null,
        text: 'private-literal',
        numeric: 123456,
        day: '2026-10-01',
      },
    ]);
    expect(result.columns.label).toBe('PUBLIC');
    expect(result.paramsHash).toBe(analyticsHash(params));
    const rows = [
      {
        label: '[RESTRICTED]',
        number: '[RESTRICTED]',
        flag: '[RESTRICTED]',
        empty: '[RESTRICTED]',
        text: '[RESTRICTED]',
        numeric: '[RESTRICTED]',
        day: '2026-10-01',
      },
    ];
    expect(audit).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ rows }));
    const persisted = (await fixture.port.audits())[0];
    expect(persisted.rows).toEqual(rows);
    expect(analyticsSiem(persisted).rows).toEqual(rows);
    for (const evidence of [persisted, analyticsSiem(persisted)]) {
      expect(JSON.stringify(evidence)).not.toContain(params.secret);
      expect(JSON.stringify(evidence)).not.toContain('private-literal');
      expect(JSON.stringify(evidence)).not.toContain('987654');
      expect(JSON.stringify(evidence)).not.toContain('123456');
    }
  });
});
