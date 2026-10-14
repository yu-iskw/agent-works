import { describe, expect, it, vi } from 'vitest';

import { analyticsFixture, analyticsPrincipal, revenueQuery } from './fixtures.js';
import { createAnalyticsService } from './service.js';

import type { EngineQuery } from '../ports/analytics.js';
describe('analytics execution pipeline', () => {
  it('runs a vetted request and records masked evidence', async () => {
    const { service, port, budget } = await analyticsFixture();
    const result = await service.query(analyticsPrincipal, revenueQuery());
    expect(result.rows).toEqual([
      { region: 'east', revenue: 40 },
      { region: 'west', revenue: 20 },
    ]);
    expect(result.vetted).toBe(true);
    expect(result.estimatedBytes).toBe(512);
    expect((await port.audits())[0].outcome).toBe('allowed');
    expect((await budget.port.events()).map((e) => e.kind)).toEqual(['charged', 'released']);
  });
  it('denies and audits an over-cap estimate before execution', async () => {
    const fixture = await analyticsFixture();
    const execute = vi.fn((query: EngineQuery) => fixture.engine.execute(query));
    const service = createAnalyticsService({
      ...fixture,
      engine: { ...fixture.engine, dryRun: () => Promise.resolve({ bytes: 100001 }), execute },
    });
    await expect(service.query(analyticsPrincipal, revenueQuery())).rejects.toThrow(
      'BYTE_CAP_EXCEEDED',
    );
    expect(execute).not.toHaveBeenCalled();
    expect(await fixture.budget.port.events()).toEqual([]);
    expect((await fixture.port.audits())[0]).toMatchObject({
      outcome: 'denied',
      reason: 'BYTE_CAP_EXCEEDED',
      estimatedBytes: 100001,
      rows: [],
    });
  });
  it.each([-1, NaN, Infinity, 1.5, Number.MAX_SAFE_INTEGER + 1])(
    'fails closed on invalid estimate %s',
    async (bytes) => {
      const fixture = await analyticsFixture();
      const execute = vi.fn((query: EngineQuery) => fixture.engine.execute(query));
      const service = createAnalyticsService({
        ...fixture,
        engine: { dryRun: () => Promise.resolve({ bytes }), execute },
      });
      await expect(service.query(analyticsPrincipal, revenueQuery())).rejects.toThrow(
        'INVALID_ESTIMATE',
      );
      expect(execute).not.toHaveBeenCalled();
      expect((await fixture.port.audits())[0].outcome).toBe('failed');
    },
  );
  it('audits dataset denial without executing or estimating', async () => {
    const fixture = await analyticsFixture();
    const dryRun = vi.fn((query: EngineQuery) => fixture.engine.dryRun(query));
    const service = createAnalyticsService({ ...fixture, engine: { ...fixture.engine, dryRun } });
    await expect(
      service.query({ ...analyticsPrincipal, datasets: [] }, revenueQuery()),
    ).rejects.toThrow('DATASET_FORBIDDEN');
    expect(dryRun).not.toHaveBeenCalled();
    expect((await fixture.port.audits())[0].reason).toBe('DATASET_FORBIDDEN');
  });
  it('releases reservation and audits an engine failure', async () => {
    const fixture = await analyticsFixture();
    const service = createAnalyticsService({
      ...fixture,
      engine: {
        ...fixture.engine,
        execute: () => Promise.reject(new Error('private credentials')),
      },
    });
    await expect(service.query(analyticsPrincipal, revenueQuery())).rejects.toThrow(
      'private credentials',
    );
    const audit = (await fixture.port.audits())[0];
    expect(audit.reason).toBe('ANALYTICS_UNAVAILABLE');
    expect(JSON.stringify(audit)).not.toContain('private credentials');
    expect((await fixture.budget.port.events()).at(-1)?.kind).toBe('released');
  });
  it('fails closed if audit cannot persist', async () => {
    const fixture = await analyticsFixture();
    const service = createAnalyticsService({
      ...fixture,
      port: { ...fixture.port, audit: () => Promise.reject(new Error('audit unavailable')) },
    });
    await expect(service.query(analyticsPrincipal, revenueQuery())).rejects.toThrow(
      'audit unavailable',
    );
    expect((await fixture.budget.port.events()).at(-1)?.kind).toBe('released');
  });
  it('does not allow the result row cap to be ignored by a transport', async () => {
    const fixture = await analyticsFixture();
    const service = createAnalyticsService({
      ...fixture,
      engine: {
        ...fixture.engine,
        execute: () =>
          Promise.resolve(Array.from({ length: 21 }, () => ({ region: 'east', revenue: 1 }))),
      },
    });
    await expect(service.query(analyticsPrincipal, revenueQuery())).rejects.toThrow(
      'ENGINE_ROW_CAP',
    );
  });
});

describe('analytics boundary defenses', () => {
  it('masks restricted results and persisted evidence together', async () => {
    const fixture = await analyticsFixture();
    const auditId = 'c1000000-0000-4000-8000-000000000001';
    const service = createAnalyticsService({
      ...fixture,
      port: {
        ...fixture.port,
        audit: (event) => fixture.port.audit({ ...event, id: auditId }),
      },
    });
    const result = await service.query(analyticsPrincipal, {
      kind: 'sql',
      sql: 'SELECT customer_id AS alias FROM approved.sales WHERE day >= @start LIMIT 20',
      params: { start: '2026-10-01' },
      limit: 20,
      maxBytes: 100000,
    });
    expect(result.vetted).toBe(false);
    expect(result.columns).toEqual({ alias: 'RESTRICTED' });
    expect(result.rows).toEqual([
      { alias: '[RESTRICTED]' },
      { alias: '[RESTRICTED]' },
      { alias: '[RESTRICTED]' },
    ]);
    const audit = (await fixture.port.audits())[0];
    expect(audit.id).toBe(auditId);
    expect(audit.rows).toEqual(result.rows);
    expect(JSON.stringify(audit.rows)).not.toContain('c1');
    expect(JSON.stringify(audit)).not.toContain('2026-10-01');
    expect(JSON.stringify(audit)).not.toContain('SELECT');
    expect(JSON.stringify(audit)).not.toContain('alice');
  });
  it.each(['*', 'day', 'email'])(
    'masks COUNT(%s) membership probes and audit rows',
    async (column) => {
      const { service, port } = await analyticsFixture();
      const result = await service.query(analyticsPrincipal, {
        kind: 'sql',
        sql: `SELECT COUNT(${column}) AS n FROM approved.customers WHERE day >= '2026-10-01' AND email >= 'b' LIMIT 20`,
        params: {},
        limit: 20,
        maxBytes: 100000,
      });
      expect(result.columns).toEqual({ n: 'RESTRICTED' });
      expect(result.rows).toEqual([{ n: '[RESTRICTED]' }]);
      expect((await port.audits())[0].rows).toEqual(result.rows);
    },
  );
  it('denies a dataset-specific byte cap before engine execution', async () => {
    const fixture = await analyticsFixture();
    const dataset = (await fixture.port.catalog()).datasets.find(
      (d) => d.name === 'approved.sales',
    );
    if (dataset === undefined) throw new Error('fixture');
    await fixture.port.putDataset({ ...dataset, maxBytes: 511 });
    const execute = vi.fn((q: EngineQuery) => fixture.engine.execute(q));
    const service = createAnalyticsService({ ...fixture, engine: { ...fixture.engine, execute } });
    await expect(service.query(analyticsPrincipal, revenueQuery())).rejects.toThrow(
      'BYTE_CAP_EXCEEDED',
    );
    expect(execute).not.toHaveBeenCalled();
    expect((await fixture.port.audits())[0].estimatedBytes).toBe(512);
  });
  it('denies a server-wide cap below the request and dataset caps', async () => {
    const fixture = await analyticsFixture();
    const execute = vi.fn((q: EngineQuery) => fixture.engine.execute(q));
    const service = createAnalyticsService({
      ...fixture,
      limits: { ...fixture.limits, maxBytes: 511 },
      engine: { ...fixture.engine, execute },
    });
    await expect(service.query(analyticsPrincipal, revenueQuery())).rejects.toThrow(
      'BYTE_CAP_EXCEEDED',
    );
    expect(execute).not.toHaveBeenCalled();
  });
  it('enforces the request row ceiling for free SQL', async () => {
    const { service, port } = await analyticsFixture();
    await expect(
      service.query(analyticsPrincipal, {
        kind: 'sql',
        sql: "SELECT amount FROM approved.sales WHERE day >= '2026-10-01' LIMIT 20",
        params: {},
        limit: 1,
        maxBytes: 100000,
      }),
    ).rejects.toThrow('SQL_LIMIT_CAP');
    expect((await port.audits())[0].reason).toBe('SQL_LIMIT_CAP');
  });
  it('denies budget exhaustion before executing an otherwise admitted query', async () => {
    const fixture = await analyticsFixture();
    const execute = vi.fn((q: EngineQuery) => fixture.engine.execute(q));
    const service = createAnalyticsService({
      ...fixture,
      engine: { ...fixture.engine, execute },
      budget: {
        ...fixture.budget,
        policy: {
          ...fixture.budget.policy,
          task: { ...fixture.budget.policy.task, estimatedCostMicros: 0 },
        },
      },
    });
    await expect(service.query(analyticsPrincipal, revenueQuery())).rejects.toThrow(
      'BUDGET_EXCEEDED',
    );
    expect(execute).not.toHaveBeenCalled();
    expect((await fixture.port.audits())[0].reason).toBe('BUDGET_EXCEEDED');
  });
  it('shares the cumulative user budget across separate task scopes', async () => {
    const fixture = await analyticsFixture();
    const service = createAnalyticsService({
      ...fixture,
      budget: {
        ...fixture.budget,
        policy: {
          ...fixture.budget.policy,
          user: { ...fixture.budget.policy.user, estimatedCostMicros: 1 },
        },
      },
    });
    await expect(
      service.query(analyticsPrincipal, revenueQuery(), 'task-one'),
    ).resolves.toMatchObject({ vetted: true });
    await expect(service.query(analyticsPrincipal, revenueQuery(), 'task-two')).rejects.toThrow(
      'BUDGET_EXCEEDED',
    );
    expect((await fixture.port.audits()).map((a) => a.outcome)).toEqual(['allowed', 'denied']);
  });
  it('rejects invalid scalar engine output before returning success', async () => {
    const fixture = await analyticsFixture();
    const service = createAnalyticsService({
      ...fixture,
      engine: {
        ...fixture.engine,
        execute: () => Promise.resolve([{ region: 'east', revenue: Infinity }]),
      },
    });
    await expect(service.query(analyticsPrincipal, revenueQuery())).rejects.toThrow(
      'ENGINE_RESULT',
    );
    expect((await fixture.port.audits())[0]).toMatchObject({
      outcome: 'failed',
      reason: 'ENGINE_RESULT',
      rows: [],
    });
  });
  it('drops an unexpected secret from engine results and audit', async () => {
    const fixture = await analyticsFixture();
    const service = createAnalyticsService({
      ...fixture,
      engine: {
        ...fixture.engine,
        execute: () =>
          Promise.resolve([{ region: 'east', revenue: 40, secret: 'private-transport-value' }]),
      },
    });
    const result = await service.query(analyticsPrincipal, revenueQuery());
    expect(result.rows).toEqual([{ region: 'east', revenue: 40 }]);
    expect(JSON.stringify(await fixture.port.audits())).not.toContain('private-transport-value');
  });
});
