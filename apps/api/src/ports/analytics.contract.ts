import { randomUUID } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { analyticsHash, analyticsPlanHash } from '../analytics/domain.js';
import {
  analyticsAt,
  analyticsDatasets,
  analyticsMetrics,
  analyticsReportId,
} from '../analytics/fixtures.js';

import type { AnalyticsPort } from './analytics.js';
function reportInput() {
  return {
    id: randomUUID(),
    reportId: analyticsReportId,
    owner: 'alice',
    title: 'Validated revenue',
    validatedBy: 'alice',
    validatedAt: analyticsAt,
    sql: 'SELECT SUM(amount) AS revenue FROM approved.sales WHERE day >= @start LIMIT 20',
    params: { start: '2026-10-01' },
    vetted: true,
    metric: 'revenue',
    classification: 'CONFIDENTIAL' as const,
  };
}
export function analyticsPortContract(port: () => AnalyticsPort): void {
  describe('analytics storage contract', () => {
    it('stores and replaces approved datasets by logical name', async () => {
      const d = analyticsDatasets[0];
      await port().putDataset(d);
      await port().putDataset({ ...d, maxBytes: 100 });
      expect((await port().catalog()).datasets).toEqual([{ ...d, maxBytes: 100 }]);
    });
    it('requires a dataset before metric registration', async () => {
      await expect(port().putMetric(analyticsMetrics[0])).rejects.toThrow('DATASET_NOT_ALLOWED');
      expect((await port().catalog()).metrics).toEqual([]);
    });
    it('stores metric definitions without exposing internal mutable state', async () => {
      await port().putDataset(analyticsDatasets[0]);
      await port().putMetric(analyticsMetrics[0]);
      const catalog = await port().catalog();
      const metric = catalog.metrics[0];
      metric.dimensions.push('secret');
      expect((await port().catalog()).metrics[0].dimensions).not.toContain('secret');
    });
    it('creates immutable sequential versions', async () => {
      const input = reportInput();
      const first = await port().saveReport(input);
      const second = await port().saveReport({ ...input, id: randomUUID(), title: 'Edited title' });
      expect(first.version).toBe(1);
      expect(second.version).toBe(2);
      expect(first.hash).toBe(analyticsPlanHash(input));
      expect(await port().report(first.id)).toEqual(first);
    });
    it('rejects duplicate immutable version identity', async () => {
      const input = reportInput();
      await port().saveReport(input);
      await expect(port().saveReport({ ...input, sql: 'altered' })).rejects.toThrow(
        'VERSION_EXISTS',
      );
    });
    it('protects a report owner when creating later versions', async () => {
      const input = reportInput();
      await port().saveReport(input);
      await expect(
        port().saveReport({ ...input, id: randomUUID(), owner: 'bob', validatedBy: 'bob' }),
      ).rejects.toThrow('REPORT_FORBIDDEN');
      expect(await port().reports('bob')).toEqual([]);
    });
    it('requires the owner to validate the report', async () => {
      await expect(port().saveReport({ ...reportInput(), validatedBy: 'bob' })).rejects.toThrow(
        'REPORT_VALIDATOR',
      );
      expect(await port().reports('alice')).toEqual([]);
    });
    it('serializes concurrent report version allocation', async () => {
      const input = reportInput();
      const versions = await Promise.all(
        Array.from({ length: 8 }, () => port().saveReport({ ...input, id: randomUUID() })),
      );
      expect(versions.map((v) => v.version).sort((a, b) => a - b)).toEqual([
        1, 2, 3, 4, 5, 6, 7, 8,
      ]);
    });
    it('returns undefined for an unknown version', async () =>
      expect(await port().report(randomUUID())).toBeUndefined());
    it('masks restricted audit columns before storing evidence', async () => {
      const id = randomUUID();
      await port().audit({
        id,
        subjectHash: analyticsHash('alice'),
        queryHash: analyticsHash('query'),
        paramsHash: analyticsHash({}),
        at: analyticsAt,
        outcome: 'allowed',
        reason: null,
        vetted: false,
        estimatedBytes: 100,
        columns: { email: 'RESTRICTED', region: 'INTERNAL' },
        rows: [{ email: 'secret@example.invalid', region: 'east' }],
      });
      const audits = await port().audits();
      expect(audits[0].rows).toEqual([{ email: '[RESTRICTED]', region: 'east' }]);
      await expect(port().audit(audits[0])).rejects.toThrow('AUDIT_EXISTS');
      expect(await port().audits()).toHaveLength(1);
    });
    it('validates the partition column belongs to the catalog', async () => {
      await expect(
        port().putDataset({ ...analyticsDatasets[0], partitionColumn: 'secret' }),
      ).rejects.toThrow();
      expect((await port().catalog()).datasets).toEqual([]);
    });
  });
}
