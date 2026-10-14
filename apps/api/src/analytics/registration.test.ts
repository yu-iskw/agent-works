import { describe, expect, it } from 'vitest';

import { analyticsFixture } from './fixtures.js';
import { analyticsRoutes } from './registration.js';

import type { Caller } from '../auth/iap.js';
describe('explicit trusted route registration', () => {
  it('does not create a default permissive authority resolver', () =>
    expect(analyticsRoutes(undefined)).toEqual({}));
  it('registers query, metrics, report versions and rerun', async () => {
    const { service } = await analyticsFixture();
    const routes = analyticsRoutes({
      service,
      verify: () => Promise.resolve({ sub: 'alice', assertion: 'verified' } as Caller),
      authority: () => Promise.resolve({ roles: ['analyst'], datasets: ['approved.sales'] }),
    });
    expect(Object.keys(routes).sort((a, b) => a.localeCompare(b))).toEqual([
      'GET /v1/analytics/metrics',
      'GET /v1/analytics/reports',
      'POST /v1/analytics/query',
      'POST /v1/analytics/reports',
      'POST /v1/analytics/reports/rerun',
    ]);
  });
});
