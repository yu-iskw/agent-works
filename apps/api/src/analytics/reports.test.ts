import { describe, expect, it } from 'vitest';

import {
  analyticsFixture,
  analyticsPrincipal,
  analyticsReportId,
  revenueQuery,
} from './fixtures.js';
import { createAnalyticsService } from './service.js';
const save = () => ({
  reportId: analyticsReportId,
  title: 'Revenue by region',
  humanValidated: true as const,
  query: revenueQuery(),
});
describe('human validated immutable reports', () => {
  it('reruns frozen SQL byte for byte with identical fixture results', async () => {
    const { service } = await analyticsFixture();
    const version = await service.save(analyticsPrincipal, save());
    const a = await service.rerun(analyticsPrincipal, version.id, 100000);
    const b = await service.rerun(analyticsPrincipal, version.id, 100000);
    expect(Buffer.from(a.sql)).toEqual(Buffer.from(version.sql));
    expect(Buffer.from(b.sql)).toEqual(Buffer.from(a.sql));
    expect(JSON.stringify(b.rows)).toBe(JSON.stringify(a.rows));
  });
  it('creates a new version on edit and preserves the original SQL', async () => {
    const { service, port } = await analyticsFixture();
    const original = await service.save(analyticsPrincipal, save());
    const query = revenueQuery();
    if (query.kind !== 'metric') throw new Error('fixture');
    query.dimensions = ['day'];
    const edited = await service.save(analyticsPrincipal, { ...save(), query });
    expect(edited.version).toBe(2);
    expect(edited.id).not.toBe(original.id);
    expect(edited.hash).not.toBe(original.hash);
    expect(await port.report(original.id)).toEqual(original);
  });
  it('does not recompile an old report against an edited metric', async () => {
    const { service, port } = await analyticsFixture();
    const report = await service.save(analyticsPrincipal, save());
    const metric = (await port.catalog()).metrics.find((m) => m.name === 'revenue')!;
    await port.putMetric({ ...metric, sqlTemplate: metric.sqlTemplate.replace('SUM', 'MAX') });
    expect((await service.rerun(analyticsPrincipal, report.id, 100000)).sql).toBe(report.sql);
  });
  it('reauthorizes grants on every rerun', async () => {
    const { service } = await analyticsFixture();
    const report = await service.save(analyticsPrincipal, save());
    await expect(
      service.rerun({ ...analyticsPrincipal, datasets: [] }, report.id, 100000),
    ).rejects.toThrow('DATASET_FORBIDDEN');
  });
  it('denies another owner', async () => {
    const { service } = await analyticsFixture();
    const report = await service.save(analyticsPrincipal, save());
    await expect(
      service.rerun({ ...analyticsPrincipal, subject: 'bob' }, report.id, 100000),
    ).rejects.toThrow('REPORT_FORBIDDEN');
  });
  it('detects corruption in a persisted version', async () => {
    const fixture = await analyticsFixture();
    const report = await fixture.service.save(analyticsPrincipal, save());
    const service = createAnalyticsService({
      ...fixture,
      port: {
        ...fixture.port,
        report: () => Promise.resolve({ ...report, sql: report.sql.replace('SUM', 'AVG') }),
      },
    });
    await expect(service.rerun(analyticsPrincipal, report.id, 100000)).rejects.toThrow(
      'REPORT_INTEGRITY',
    );
  });
  it('requires explicit human validation', async () => {
    const { service } = await analyticsFixture();
    await expect(
      service.save(analyticsPrincipal, { ...save(), humanValidated: false as unknown as true }),
    ).rejects.toThrow();
  });
  it('applies current allowlists to frozen SQL', async () => {
    const { service, port } = await analyticsFixture();
    const report = await service.save(analyticsPrincipal, save());
    const dataset = (await port.catalog()).datasets.find((d) => d.name === 'approved.sales')!;
    await port.putDataset({
      ...dataset,
      columns: dataset.columns.filter((c) => c.name !== 'amount'),
    });
    await expect(service.rerun(analyticsPrincipal, report.id, 100000)).rejects.toThrow(
      'COLUMN_NOT_ALLOWED',
    );
  });
});

describe('report failure atomicity', () => {
  it('does not create a report when query cost is denied', async () => {
    const { service, port } = await analyticsFixture();
    const input = save();
    await expect(
      service.save(analyticsPrincipal, { ...input, query: { ...input.query, maxBytes: 1 } }),
    ).rejects.toThrow('BYTE_CAP_EXCEEDED');
    expect(await port.reports('alice')).toEqual([]);
    expect((await port.audits())[0].outcome).toBe('denied');
  });
  it('does not create a report when execution fails', async () => {
    const fixture = await analyticsFixture();
    const service = createAnalyticsService({
      ...fixture,
      engine: { ...fixture.engine, execute: () => Promise.reject(new Error('engine unavailable')) },
    });
    await expect(service.save(analyticsPrincipal, save())).rejects.toThrow('engine unavailable');
    expect(await fixture.port.reports('alice')).toEqual([]);
  });
  it('does not create a report when query evidence cannot persist', async () => {
    const fixture = await analyticsFixture();
    const service = createAnalyticsService({
      ...fixture,
      port: { ...fixture.port, audit: () => Promise.reject(new Error('evidence unavailable')) },
    });
    await expect(service.save(analyticsPrincipal, save())).rejects.toThrow('evidence unavailable');
    expect(await fixture.port.reports('alice')).toEqual([]);
  });
  it('does not erase older versions after a denied edit', async () => {
    const { service, port } = await analyticsFixture();
    const report = await service.save(analyticsPrincipal, save());
    const input = save();
    await expect(
      service.save(analyticsPrincipal, { ...input, query: { ...input.query, maxBytes: 1 } }),
    ).rejects.toThrow('BYTE_CAP_EXCEEDED');
    expect(await port.reports('alice')).toEqual([report]);
  });
  it('keeps free SQL unvetted after human report validation', async () => {
    const { service } = await analyticsFixture();
    const report = await service.save(analyticsPrincipal, {
      ...save(),
      query: {
        kind: 'sql',
        sql: "SELECT amount FROM approved.sales WHERE day >= '2026-10-01' LIMIT 20",
        params: {},
        limit: 20,
        maxBytes: 100000,
      },
    });
    expect(report.vetted).toBe(false);
    expect((await service.rerun(analyticsPrincipal, report.id, 100000)).vetted).toBe(false);
  });
});
