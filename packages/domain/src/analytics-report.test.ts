import { describe, expect, it } from 'vitest';

import { analyticsHash, analyticsPlanHash, analyticsReportSchema } from './analytics-report.js';
const plan = {
  sql: 'SELECT amount FROM approved.sales WHERE day >= @start LIMIT 20',
  params: { start: '2026-10-01' },
  vetted: true,
  metric: 'revenue',
  classification: 'CONFIDENTIAL' as const,
};
describe('immutable analytics plan identity', () => {
  it('canonicalizes parameter object order', () =>
    expect(analyticsHash({ b: 2, a: 1 })).toBe(analyticsHash({ a: 1, b: 2 })));
  it('does not normalize SQL bytes', () =>
    expect(analyticsPlanHash(plan)).not.toBe(analyticsPlanHash({ ...plan, sql: `${plan.sql} ` })));
  it('includes bound parameters in the hash', () =>
    expect(analyticsPlanHash(plan)).not.toBe(
      analyticsPlanHash({ ...plan, params: { start: '2026-10-02' } }),
    ));
  it('includes vetting state and classification in the hash', () => {
    expect(analyticsPlanHash(plan)).not.toBe(analyticsPlanHash({ ...plan, vetted: false }));
    expect(analyticsPlanHash(plan)).not.toBe(
      analyticsPlanHash({ ...plan, classification: 'RESTRICTED' }),
    );
  });
  it('validates frozen report metadata', () => {
    const report = {
      ...plan,
      id: '14700000-0000-4000-8000-000000000002',
      reportId: '14700000-0000-4000-8000-000000000001',
      version: 1,
      title: 'Revenue',
      owner: 'alice',
      validatedBy: 'alice',
      validatedAt: '2026-10-14T10:00:00.000Z',
      hash: analyticsPlanHash(plan),
    };
    expect(analyticsReportSchema.parse(report)).toEqual(report);
    expect(analyticsReportSchema.safeParse({ ...report, version: 0 }).success).toBe(false);
    expect(analyticsReportSchema.safeParse({ ...report, hash: 'invalid' }).success).toBe(false);
  });
});
