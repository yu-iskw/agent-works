import { describe, expect, it } from 'vitest';

import { Unauthenticated } from '../auth/iap.js';
import { CREATED, governanceFixture, HOLD_ID, REQUEST_ID } from '../governance/test-fixtures.js';

import { governanceRoutes } from './governance-routes.js';

import type { Caller } from '../auth/iap.js';
import type { Route } from '../http.js';
import type { GovernanceDeps } from './governance-auth.js';

const caller = { sub: 'alice', assertion: 'verified-token' } as Caller;
const deletion = { requestId: REQUEST_ID, subject: 'alice', reasonRef: 'privacy-case' };
const hold = {
  commandId: HOLD_ID,
  target: { kind: 'owner', id: 'alice' },
  action: 'set',
  reasonRef: 'hold-case',
};
function request(body: unknown = {}, headers: Record<string, string> = {}): Parameters<Route>[0] {
  return {
    method: 'POST',
    path: '/v1/admin/governance/deletions',
    headers,
    body: Buffer.from(JSON.stringify(body)),
  };
}
async function routes(roles: readonly string[]) {
  const { port } = await governanceFixture();
  const deps: GovernanceDeps = {
    port,
    rolesFor: () => Promise.resolve(roles),
    verify: () => Promise.resolve(caller),
    now: () => new Date(CREATED),
  };
  return {
    port,
    table: governanceRoutes({ ...deps, governance: { port, rolesFor: deps.rolesFor } }),
  };
}
describe('trusted governance authorization', () => {
  it.each(['Admin', 'admin', 'privacy-officer'])('permits trusted role %s', async (role) => {
    const { table } = await routes([role]);
    expect((await table['POST /v1/admin/governance/deletions'](request(deletion))).status).toBe(
      202,
    );
    expect((await table['GET /v1/admin/governance/deletions'](request())).status).toBe(200);
    expect((await table['POST /v1/admin/governance/holds'](request(hold))).status).toBe(200);
  });
  it.each(
    [[], ['Employee'], ['Reviewer'], ['privacy_officer'], ['ADMIN']].map((rolesForUser) => ({
      rolesForUser,
    })),
  )('denies nonprivileged roles %j for every route', async ({ rolesForUser }) => {
    const { table, port } = await routes(rolesForUser);
    for (const route of Object.values(table))
      expect(
        (await route(request(deletion, { 'x-role': 'admin', 'x-aw-role': 'privacy-officer' })))
          .status,
      ).toBe(403);
    expect((await port.snapshot()).requests).toEqual([]);
    expect((await port.snapshot()).holds).toEqual([]);
  });
  it('forged roles in a request body do not grant authority', async () => {
    const { table } = await routes(['Employee']);
    expect(
      (
        await table['POST /v1/admin/governance/deletions'](
          request({ ...deletion, roles: ['admin'] }),
        )
      ).status,
    ).toBe(403);
  });
  it('rejects unverified assertions before consulting the directory', async () => {
    const { port } = await governanceFixture();
    let resolved = false;
    const table = governanceRoutes({
      governance: {
        port,
        rolesFor: () => {
          resolved = true;
          return Promise.resolve(['admin']);
        },
      },
      verify: () => Promise.reject(new Unauthenticated('bad_signature')),
      now: () => new Date(CREATED),
    });
    expect((await table['POST /v1/admin/governance/deletions'](request(deletion))).status).toBe(
      401,
    );
    expect(resolved).toBe(false);
  });
  it('directory failure returns a controlled error and no write', async () => {
    const { port } = await governanceFixture();
    const table = governanceRoutes({
      governance: { port, rolesFor: () => Promise.reject(new Error('directory offline')) },
      verify: () => Promise.resolve(caller),
      now: () => new Date(CREATED),
    });
    expect((await table['POST /v1/admin/governance/deletions'](request(deletion))).status).toBe(
      503,
    );
    expect((await port.snapshot()).requests).toEqual([]);
  });
  it('requires strict command schemas and rejects oversized bodies', async () => {
    const { table } = await routes(['admin']);
    const route = table['POST /v1/admin/governance/deletions'];
    expect((await route(request({ ...deletion, role: 'admin' }))).status).toBe(400);
    expect((await route(request({ ...deletion, requestId: 'invalid' }))).status).toBe(400);
    expect((await route({ ...request(), body: Buffer.from('{broken') })).status).toBe(400);
    expect((await route({ ...request(), body: Buffer.alloc(16385) })).status).toBe(400);
  });
  it('rejects command-id conflicts without exposing command contents', async () => {
    const { table } = await routes(['admin']);
    const route = table['POST /v1/admin/governance/deletions'];
    await route(request(deletion));
    expect(await route(request({ ...deletion, subject: 'bob' }))).toEqual({
      status: 409,
      body: { error: 'governance_conflict' },
    });
  });
  it('creates, lists and processes a deletion through the admin API', async () => {
    const { table } = await routes(['privacy-officer']);
    await table['POST /v1/admin/governance/deletions'](request(deletion));
    const list = await table['GET /v1/admin/governance/deletions'](request());
    expect(list.body).toMatchObject({ requests: [{ subject: 'alice', state: 'REQUESTED' }] });
    const processed = await table['POST /v1/admin/governance/deletions/process'](
      request({ requestId: REQUEST_ID }),
    );
    expect(processed.body).toMatchObject({ state: 'PURGED' });
  });
  it('does not register a governance surface without trusted dependencies', () => {
    expect(
      governanceRoutes({ verify: () => Promise.resolve(caller), now: () => new Date(CREATED) }),
    ).toEqual({});
  });
});
