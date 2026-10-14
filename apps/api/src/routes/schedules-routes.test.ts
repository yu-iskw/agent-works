import { expect, test } from 'vitest';

import { Unauthenticated } from '../auth/iap.js';
import { schedulerFixture, eventTriggerFixture } from '../scheduling/test-fixtures.js';

import { eventsIngestRoutes } from './events-ingest.js';
import { schedulesChangeRoutes } from './schedules-change.js';
import { schedulesCreateRoutes } from './schedules-create.js';
import { schedulesReadRoutes } from './schedules-read.js';
import { schedulesRunRoutes } from './schedules-runs.js';

import { createRouteTable } from './index.js';

import type { Caller } from '../auth/iap.js';
async function fixture(subject = 'alice') {
  const f = await schedulerFixture();
  const deps = {
    store: f.store,
    scheduler: f.scheduler,
    authority: f.deps.authority,
    verify: () => Promise.resolve({ sub: subject, assertion: 'verified' } as Caller),
  };
  const routes = {
    ...schedulesReadRoutes(deps),
    ...schedulesCreateRoutes(deps),
    ...schedulesChangeRoutes(deps),
    ...schedulesRunRoutes(deps),
  };
  async function call(method: string, path: string, body?: unknown) {
    const route = routes[`${method} ${path}`];
    return route({
      method,
      path,
      headers: {},
      body: body === undefined ? Buffer.alloc(0) : Buffer.from(JSON.stringify(body)),
    });
  }
  return { ...f, deps, routes, call };
}
test('API creates, lists, previews, pauses, resumes, and reads run/history evidence', async () => {
  const f = await fixture();
  expect((await f.call('POST', '/v1/schedules/preview', f.spec)).body).toMatchObject({
    allowed: true,
    maxPrivilege: f.spec.maxPrivilege,
  });
  expect((await f.call('POST', '/v1/schedules', f.spec)).status).toBe(201);
  expect((await f.call('GET', '/v1/schedules')).body).toMatchObject({
    schedules: [{ spec: f.spec }],
  });
  expect(
    (
      await f.call('POST', '/v1/schedules/change', {
        id: f.spec.id,
        expectedRevision: 1,
        action: 'pause',
      })
    ).body,
  ).toMatchObject({ state: 'paused', revision: 2 });
  expect(
    (
      await f.call('POST', '/v1/schedules/change', {
        id: f.spec.id,
        expectedRevision: 2,
        action: 'resume',
      })
    ).status,
  ).toBe(200);
  f.clock.advance(60000);
  await f.scheduler.tick();
  expect((await f.call('POST', '/v1/schedules/runs', { id: f.spec.id })).body).toMatchObject({
    runs: [{ status: 'accepted' }],
  });
  expect((await f.call('GET', '/v1/schedules/history')).status).toBe(200);
});
test.each([
  'GET /v1/schedules',
  'GET /v1/schedules/history',
  'GET /v1/schedules/triggers',
  'POST /v1/schedules',
  'POST /v1/schedules/preview',
  'POST /v1/schedules/triggers',
  'POST /v1/schedules/change',
  'POST /v1/schedules/runs',
])('%s requires authentication', async (key) => {
  const f = await fixture();
  const deps = { ...f.deps, verify: () => Promise.reject(new Unauthenticated('missing')) };
  const routes = {
    ...schedulesReadRoutes(deps),
    ...schedulesCreateRoutes(deps),
    ...schedulesChangeRoutes(deps),
    ...schedulesRunRoutes(deps),
  };
  const route = new Map(Object.entries(routes)).get(key)!;
  const reply = await route({
    method: 'POST',
    path: key.split(' ')[1],
    headers: {},
    body: Buffer.from('{}'),
  });
  expect(reply.status).toBe(401);
});
test('owner isolation hides runs and prevents state changes or sponsor impersonation', async () => {
  const f = await fixture('bob');
  await f.scheduler.create(f.spec, 'alice');
  expect((await f.call('GET', '/v1/schedules')).body).toEqual({ schedules: [] });
  expect((await f.call('POST', '/v1/schedules/runs', { id: f.spec.id })).status).toBe(404);
  expect(
    (
      await f.call('POST', '/v1/schedules/change', {
        id: f.spec.id,
        expectedRevision: 1,
        action: 'pause',
      })
    ).status,
  ).toBe(404);
  expect((await f.call('POST', '/v1/schedules', f.spec)).status).toBe(403);
  expect((await f.call('POST', '/v1/schedules/preview', f.spec)).status).toBe(403);
});
test.each([
  '/v1/schedules',
  '/v1/schedules/preview',
  '/v1/schedules/triggers',
  '/v1/schedules/change',
  '/v1/schedules/runs',
])('invalid %s request fails before mutation', async (path) => {
  const f = await fixture();
  expect((await f.call('POST', path, { scopes: ['admin'] })).status).toBe(400);
  expect(await f.store.all()).toEqual([]);
});
test('stale revisions return conflict and preserve paused state', async () => {
  const f = await fixture();
  await f.call('POST', '/v1/schedules', f.spec);
  await f.call('POST', '/v1/schedules/change', {
    id: f.spec.id,
    expectedRevision: 1,
    action: 'pause',
  });
  expect(
    (
      await f.call('POST', '/v1/schedules/change', {
        id: f.spec.id,
        expectedRevision: 1,
        action: 'resume',
      })
    ).status,
  ).toBe(409);
  expect((await f.store.read('alice', f.spec.id))?.state).toBe('paused');
});
test('API registers event trigger and rejects its ID reuse', async () => {
  const f = await fixture();
  const trigger = eventTriggerFixture(f.spec.id);
  expect(
    (await f.call('POST', '/v1/schedules/triggers', { schedule: f.spec, trigger })).status,
  ).toBe(201);
  expect((await f.call('GET', '/v1/schedules/triggers')).body).toEqual({ triggers: [trigger] });
  expect(
    (
      await f.call('POST', '/v1/schedules/triggers', {
        schedule: f.spec,
        trigger: { ...trigger, source: 'other' },
      })
    ).status,
  ).toBe(409);
});
test('unsigned event ingestion route requires all signature metadata', async () => {
  const route = eventsIngestRoutes({ ingest: () => Promise.reject(new Error('must not run')) })[
    'POST /v1/events/ingest'
  ];
  expect(
    (
      await route({
        method: 'POST',
        path: '/v1/events/ingest',
        headers: {},
        body: Buffer.from('{}'),
      })
    ).status,
  ).toBe(401);
});
test('route errors fail closed without exposing internal configuration', async () => {
  const f = await fixture();
  const route = schedulesReadRoutes({
    ...f.deps,
    verify: () => Promise.reject(new Error('secret internal failure')),
  })['GET /v1/schedules'];
  expect(
    await route({ method: 'GET', path: '/v1/schedules', headers: {}, body: Buffer.alloc(0) }),
  ).toEqual({ status: 503, body: { error: 'scheduling_unavailable' } });
});
test('API route table exposes schedules when configured', async () => {
  const f = await fixture();
  const table = createRouteTable(
    {
      verify: f.deps.verify,
      now: f.clock.now,
      schedules: f.deps,
      drive: () => Promise.reject(new Error('unused')),
      runner: { run: () => Promise.reject(new Error('unused')) },
      audit: { append: () => Promise.reject(new Error('unused')) },
    } as unknown as Parameters<typeof createRouteTable>[0],
    {},
  );
  expect(Object.keys(table)).toContain('GET /v1/schedules');
  expect(Object.keys(table)).toContain('POST /v1/schedules/change');
});
