import { randomUUID } from 'node:crypto';

import { afterEach, expect, test, vi } from 'vitest';

import { createRoleResolver } from '../auth/directory.js';
import { createMemorySuspensionLedger } from '../ports/memory/suspension-ledger.js';

import { adminChangeRoutes } from './admin-change.js';
import { adminReadRoutes } from './admin-read.js';

import type { Caller } from '../auth/iap.js';
import type { Route } from '../http.js';

const at = new Date('2026-10-14T10:00:00.000Z');
const adminGroup = 'agent-admins@company.example';
afterEach(() => vi.unstubAllGlobals());
function world() {
  const ledger = createMemorySuspensionLedger();
  const rolesFor = createRoleResolver({
    baseUrl: 'http://trusted-directory.local',
    now: () => at.getTime(),
  });
  const deps = {
    ledger,
    rolesFor,
    now: () => at,
    verify: () => Promise.resolve({ sub: 'alice', assertion: 'verified' } as Caller),
  };
  const routes = new Map(Object.entries({ ...adminReadRoutes(deps), ...adminChangeRoutes(deps) }));
  function route(key: string): Route {
    const value = routes.get(key);
    if (value === undefined) throw new Error('route');
    return value;
  }
  return { ledger, route };
}
function request(action = 'suspend', expectedRevision = 0) {
  return {
    method: 'POST',
    path: '/v1/admin/suspensions',
    headers: {
      'content-type': 'application/json',
      'x-goog-iap-jwt-assertion': 'verified',
      'x-app-role': 'Admin',
    },
    body: Buffer.from(
      JSON.stringify({
        commandId: randomUUID(),
        action,
        expectedRevision,
        target: { scope: 'global', id: '*', version: null },
        reason: 'Trusted directory test',
        expiresAt: null,
      }),
    ),
  };
}

test('fresh trusted directory membership, not a role header, authorizes one audited change', async () => {
  const load = vi
    .fn<typeof fetch>()
    .mockResolvedValue(
      Response.json({ sub: 'alice', groups: [adminGroup], observedAt: at.toISOString() }),
    );
  vi.stubGlobal('fetch', load);
  const app = world();
  const result = await app.route('POST /v1/admin/suspensions')(request());
  expect(result.status).toBe(200);
  expect(await app.ledger.history()).toHaveLength(1);
  expect((await app.ledger.history())[0].actorSub).toBe('alice');
  expect(load).toHaveBeenCalledWith(
    new URL('http://trusted-directory.local/snapshots/alice'),
    expect.objectContaining({ redirect: 'error' }),
  );
});

test.each([
  {
    name: 'stale group snapshot',
    body: {
      sub: 'alice',
      groups: [adminGroup],
      observedAt: new Date(at.getTime() - 300_001).toISOString(),
    },
  },
  {
    name: 'snapshot too far in the future',
    body: {
      sub: 'alice',
      groups: [adminGroup],
      observedAt: new Date(at.getTime() + 30_001).toISOString(),
    },
  },
  {
    name: 'another directory subject',
    body: { sub: 'bob', groups: [adminGroup], observedAt: at.toISOString() },
  },
  {
    name: 'client role without a trusted group',
    body: { sub: 'alice', groups: ['Admin'], observedAt: at.toISOString() },
  },
  {
    name: 'reviewer membership',
    body: {
      sub: 'alice',
      groups: ['agent-reviewers@company.example'],
      observedAt: at.toISOString(),
    },
  },
  {
    name: 'unrecognized role field',
    body: { sub: 'alice', groups: [], observedAt: at.toISOString(), role: 'Admin' },
  },
  {
    name: 'unrecognized groups shape',
    body: { sub: 'alice', groups: adminGroup, observedAt: at.toISOString() },
  },
])('$name cannot authorize a forged-role request', async ({ body }) => {
  vi.stubGlobal('fetch', () => Promise.resolve(Response.json(body)));
  const app = world();
  expect((await app.route('POST /v1/admin/suspensions')(request())).status).toBe(403);
  expect((await app.route('GET /v1/admin/history')(request())).status).toBe(403);
  expect(await app.ledger.history()).toEqual([]);
  expect(await app.ledger.snapshot()).toEqual({ suspensions: [], versions: [] });
});

test('directory role removal takes effect on the next request', async () => {
  let groups = [adminGroup];
  vi.stubGlobal('fetch', () =>
    Promise.resolve(Response.json({ sub: 'alice', groups, observedAt: at.toISOString() })),
  );
  const app = world();
  expect((await app.route('POST /v1/admin/suspensions')(request())).status).toBe(200);
  groups = [];
  expect((await app.route('POST /v1/admin/suspensions')(request('resume', 1))).status).toBe(403);
  expect((await app.ledger.snapshot()).suspensions[0].suspended).toBe(true);
  expect(await app.ledger.history()).toHaveLength(1);
});

test.each([404, 429, 503])(
  'directory HTTP %s fails closed even with a forged role header',
  async (status) => {
    vi.stubGlobal('fetch', () => Promise.resolve(new Response(null, { status })));
    const app = world();
    expect((await app.route('POST /v1/admin/suspensions')(request())).status).toBe(403);
    expect(await app.ledger.history()).toHaveLength(0);
  },
);

test('unreachable directory fails closed and does not expose the provider error', async () => {
  vi.stubGlobal('fetch', () => Promise.reject(new Error('directory credential canary')));
  const app = world();
  const reply = await app.route('POST /v1/admin/suspensions')(request());
  expect(reply).toEqual({ status: 403, body: { error: 'forbidden' } });
  expect(JSON.stringify(reply)).not.toContain('credential canary');
  expect(await app.ledger.history()).toEqual([]);
});
