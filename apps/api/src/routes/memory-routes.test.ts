import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { Unauthenticated } from '../auth/iap.js';
import { memoryFixture, memoryProposal, MEMORY_AT } from '../memory/test-fixtures.js';
import { proposeMemory } from '../memory/write.js';

import { memoryRoutes } from './memory-routes.js';

import type { Caller } from '../auth/iap.js';
import type { Route } from '../http.js';
function request(body: unknown = {}, headers: Record<string, string> = {}): Parameters<Route>[0] {
  return { method: 'POST', path: '/v1/memory', headers, body: Buffer.from(JSON.stringify(body)) };
}
function setup(owner = 'alice') {
  const f = memoryFixture();
  const verify = () => Promise.resolve({ sub: owner, assertion: 'trusted' } as Caller);
  const deps = {
    store: f.store,
    policy: f.policy,
    verify,
    tenantFor: () => Promise.resolve('tenant-a'),
  };
  return { ...f, deps, routes: memoryRoutes(deps) };
}
describe('own memory HTTP routes', () => {
  it('does not mount without explicit injection', () => {
    expect(memoryRoutes(undefined)).toEqual({});
  });
  it('shows consent off and notice before any memory exists', async () => {
    const f = setup();
    const response = await f.routes['GET /v1/memory/consent'](request());
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      consent: { enabled: false, revision: 0 },
      tenantEnabled: true,
    });
    expect(response.body).toHaveProperty('notice');
  });
  it('strict consent commands reject forged subjects and roles', async () => {
    const f = setup();
    const response = await f.routes['POST /v1/memory/consent'](
      request({
        enabled: true,
        revision: 0,
        noticeVersion: 'memory-v1',
        owner: 'bob',
        roles: ['admin'],
      }),
    );
    expect(response.status).toBe(400);
    expect(await f.store.transaction((state) => state.consents)).toEqual([]);
  });
  it('authenticated caller ownership overrides forged headers', async () => {
    const f = setup();
    await f.routes['POST /v1/memory/consent'](
      request(
        { enabled: true, revision: 0, noticeVersion: 'memory-v1' },
        { 'x-user-sub': 'bob', 'x-tenant': 'other' },
      ),
    );
    const proposal = memoryProposal();
    const item = await proposeMemory(f.store, f.policy, { ...f.scope, agent: 'default' }, proposal);
    const response = await f.routes['GET /v1/memory'](request({}, { 'x-user-sub': 'bob' }));
    expect(response.status).toBe(200);
    expect(response.body).toEqual({ items: [item] });
    expect((await f.store.transaction((state) => state.consents))[0].owner).toBe('alice');
  });
  it('user B cannot list or export user A memory', async () => {
    const f = setup();
    await f.enable();
    await f.put();
    const bob = memoryRoutes({
      ...f.deps,
      verify: () => Promise.resolve({ sub: 'bob', assertion: 'trusted' } as Caller),
    });
    expect((await bob['GET /v1/memory'](request())).body).toEqual({ items: [] });
    expect((await bob['GET /v1/memory/export'](request())).body).toMatchObject({ items: [] });
    expect((await bob['POST /v1/memory/list'](request({ agent: 'assistant' }))).body).toEqual({
      items: [],
    });
  });
  it('B cannot edit or delete a known A id with the right agent', async () => {
    const f = setup();
    await f.enable();
    const item = await f.put();
    const bob = memoryRoutes({
      ...f.deps,
      verify: () => Promise.resolve({ sub: 'bob', assertion: 'trusted' } as Caller),
    });
    const command = { id: item.id, agent: item.agent, revision: 1 };
    expect(
      (await bob['POST /v1/memory/edit'](request({ ...command, text: 'forged' }))).status,
    ).toBe(409);
    expect((await bob['POST /v1/memory/delete'](request(command))).status).toBe(409);
    expect(await f.store.transaction((state) => state.items)).toHaveLength(1);
  });
  it('allows own edit and delete with revision checks', async () => {
    const f = setup();
    await f.enable();
    const item = await f.put();
    const command = { id: item.id, agent: item.agent, revision: 1 };
    expect(
      (await f.routes['POST /v1/memory/edit'](request({ ...command, text: 'Updated' }))).status,
    ).toBe(200);
    expect((await f.routes['POST /v1/memory/delete'](request(command))).status).toBe(409);
    expect(
      (await f.routes['POST /v1/memory/delete'](request({ ...command, revision: 2 }))).body,
    ).toEqual({ deleted: true });
    expect(await f.store.transaction((state) => state.history)).toEqual([]);
  });
  it('rejects edits when tenant memory is disabled but keeps own erasure available', async () => {
    const f = setup();
    await f.enable();
    const item = await f.put();
    const before = await f.store.transaction((state) => state);
    f.setTenant(false);
    const command = { id: item.id, agent: item.agent, revision: item.revision };
    expect(
      (await f.routes['POST /v1/memory/edit'](request({ ...command, text: 'disabled edit' })))
        .status,
    ).toBe(403);
    expect(await f.store.transaction((state) => state)).toEqual(before);
    expect((await f.routes['POST /v1/memory/delete'](request(command))).status).toBe(200);
    expect(await f.store.transaction((state) => state.history)).toEqual([]);
  });
  it('source ACL loss removes source-linked memory from list and export', async () => {
    const f = setup();
    await f.enable();
    const proposal = memoryProposal();
    proposal.origin.sourceRef = 'doc';
    await proposeMemory(f.store, f.policy, { ...f.scope, agent: 'default' }, proposal);
    f.setAcl(false);
    expect((await f.routes['GET /v1/memory'](request())).body).toEqual({ items: [] });
    expect((await f.routes['GET /v1/memory/export'](request())).body).toMatchObject({
      items: [],
      exportedAt: MEMORY_AT,
    });
  });
  it.each([
    'GET /v1/memory',
    'GET /v1/memory/consent',
    'GET /v1/memory/export',
    'POST /v1/memory/edit',
    'POST /v1/memory/delete',
  ])('requires authentication for %s', async (path) => {
    const f = setup();
    const routes = memoryRoutes({
      ...f.deps,
      verify: () => Promise.reject(new Unauthenticated('missing')),
    });
    // eslint-disable-next-line security/detect-object-injection -- path is from the fixed route cases above
    const response = await routes[path](request());
    expect(response.status).toBe(401);
    expect(response.body).toEqual({ error: 'unauthenticated' });
  });
  it('does not expose verification or storage error details', async () => {
    const f = setup();
    const routes = memoryRoutes({
      ...f.deps,
      tenantFor: () => Promise.reject(new Error('SECRET_DIRECTORY_URL')),
    });
    expect((await routes['GET /v1/memory'](request())).body).toEqual({
      error: 'memory_unavailable',
    });
  });
  it('rejects malformed and oversized command bodies', async () => {
    const f = setup();
    for (const body of [Buffer.from('{'), Buffer.alloc(16385, 'x')]) {
      const response = await f.routes['POST /v1/memory/consent']({ ...request(), body });
      expect(response.status).toBe(400);
    }
  });
  it('opt-out route erases memories across agents', async () => {
    const f = setup();
    await f.enable();
    await f.put();
    const response = await f.routes['POST /v1/memory/consent'](
      request({ enabled: false, revision: 1, noticeVersion: 'memory-v1' }),
    );
    expect(response.status).toBe(200);
    expect(await f.store.transaction((state) => state.items)).toEqual([]);
  });
});

it('focused OpenAPI operations cover the exact registered own-memory route table', () => {
  const spec = JSON.parse(
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- fixed repository contract
    readFileSync(new URL('../../../../docs/memory/openapi.json', import.meta.url), 'utf8'),
  ) as { paths: Record<string, Record<string, { responses: Record<string, unknown> }>> };
  const f = setup();
  const documented = Object.entries(spec.paths).flatMap(([path, methods]) =>
    Object.entries(methods).map(([method, operation]) => {
      expect(operation.responses).toHaveProperty('401');
      return `${method.toUpperCase()} ${path}`;
    }),
  );
  expect(documented.sort((a, b) => a.localeCompare(b))).toEqual(
    Object.keys(f.routes).sort((a, b) => a.localeCompare(b)),
  );
});
