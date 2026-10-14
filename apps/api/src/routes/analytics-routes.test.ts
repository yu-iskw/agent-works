import { describe, expect, it } from 'vitest';

import {
  analyticsFixture,
  analyticsPrincipal,
  analyticsReportId,
  revenueQuery,
} from '../analytics/fixtures.js';
import { analyticsRoutes } from '../analytics/registration.js';
import { Unauthenticated } from '../auth/iap.js';

import type { Caller } from '../auth/iap.js';
import type { Route } from '../http.js';
function request(body: unknown = {}, headers: Record<string, string> = {}): Parameters<Route>[0] {
  return {
    method: 'POST',
    path: '/v1/analytics/query',
    headers,
    body: Buffer.from(JSON.stringify(body)),
  };
}
async function setup(
  roles: readonly string[] = ['analyst'],
  datasets: readonly string[] = analyticsPrincipal.datasets,
) {
  const fixture = await analyticsFixture();
  const deps = {
    service: fixture.service,
    verify: () => Promise.resolve({ sub: 'alice', assertion: 'verified' } as Caller),
    authority: () => Promise.resolve({ roles, datasets }),
  };
  return { ...fixture, deps, routes: analyticsRoutes(deps) };
}
describe('analytics API authentication and authority', () => {
  it('runs the guarded metric query', async () => {
    const { routes } = await setup();
    const response = await routes['POST /v1/analytics/query'](request(revenueQuery()));
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      vetted: true,
      rows: [
        { region: 'east', revenue: 40 },
        { region: 'west', revenue: 20 },
      ],
    });
  });
  it('returns 403 without a trusted dataset grant', async () => {
    const { routes } = await setup(['analyst'], []);
    expect(await routes['POST /v1/analytics/query'](request(revenueQuery()))).toEqual({
      status: 403,
      body: { error: 'DATASET_FORBIDDEN' },
    });
  });
  it.each([[], ['Employee'], ['Admin'], ['ANALYST']].map((roles) => ({ roles })))(
    'returns 403 for forged role headers ($roles)',
    async ({ roles }) => {
      const { routes } = await setup(roles);
      for (const route of Object.values(routes))
        expect(
          (
            await route(
              request(revenueQuery(), {
                'x-role': 'analyst',
                'x-datasets': 'approved.sales',
                'x-user': 'alice',
              }),
            )
          ).status,
        ).toBe(403);
    },
  );
  it('does not accept roles or grants from a JSON body', async () => {
    const { routes } = await setup([]);
    expect(
      (
        await routes['POST /v1/analytics/query'](
          request({ ...revenueQuery(), roles: ['analyst'], datasets: ['approved.sales'] }),
        )
      ).status,
    ).toBe(403);
  });
  it('rejects malformed JSON with a safe response', async () => {
    const { routes } = await setup();
    expect(
      await routes['POST /v1/analytics/query']({
        ...request(),
        body: Buffer.from('{private garbage'),
      }),
    ).toEqual({ status: 400, body: { error: 'INVALID_ANALYTICS_REQUEST' } });
  });
  it('rejects unknown request fields', async () => {
    const { routes } = await setup();
    expect(
      (
        await routes['POST /v1/analytics/query'](
          request({ ...revenueQuery(), sql: 'DELETE FROM x' }),
        )
      ).status,
    ).toBe(400);
  });
  it('returns 401 for failed IAP verification', async () => {
    const { deps } = await setup();
    const routes = analyticsRoutes({
      ...deps,
      verify: () => Promise.reject(new Unauthenticated('missing')),
    });
    expect((await routes['POST /v1/analytics/query'](request(revenueQuery()))).status).toBe(401);
  });
  it('returns 503 for a directory outage without leaking details', async () => {
    const { deps } = await setup();
    const routes = analyticsRoutes({
      ...deps,
      authority: () => Promise.reject(new Error('secret credential')),
    });
    expect(await routes['GET /v1/analytics/metrics'](request())).toEqual({
      status: 503,
      body: { error: 'ANALYTICS_UNAVAILABLE' },
    });
  });
  it('lists only metrics with a dataset grant', async () => {
    const { routes } = await setup(['analyst'], []);
    expect(await routes['GET /v1/analytics/metrics'](request())).toEqual({
      status: 200,
      body: { metrics: [] },
    });
  });
  it('saves a human validated version and reruns by id', async () => {
    const { routes } = await setup();
    const saved = await routes['POST /v1/analytics/reports'](
      request({
        reportId: analyticsReportId,
        title: 'Revenue',
        humanValidated: true,
        query: revenueQuery(),
      }),
    );
    expect(saved.status).toBe(201);
    const version = saved.body as { id: string; sql: string };
    const rerun = await routes['POST /v1/analytics/reports/rerun'](
      request({ versionId: version.id, maxBytes: 100000 }),
    );
    expect(rerun.status).toBe(200);
    expect(rerun.body).toMatchObject({ sql: version.sql });
    expect((await routes['GET /v1/analytics/reports'](request())).status).toBe(200);
  });
  it('rejects an unvalidated save', async () => {
    const { routes } = await setup();
    expect(
      (
        await routes['POST /v1/analytics/reports'](
          request({
            reportId: analyticsReportId,
            title: 'Revenue',
            humanValidated: false,
            query: revenueQuery(),
          }),
        )
      ).status,
    ).toBe(400);
  });
});
