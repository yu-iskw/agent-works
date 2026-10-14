import { randomUUID } from 'node:crypto';

import { describe, expect, test } from 'vitest';

import { Unauthenticated } from '../auth/iap.js';
import { createMemorySuspensionLedger } from '../ports/memory/suspension-ledger.js';

import { adminChangeRoutes } from './admin-change.js';
import { adminReadRoutes } from './admin-read.js';

import type { AppRole } from '../auth/directory.js';
import type { Caller } from '../auth/iap.js';
import type { Route } from '../http.js';

const at = new Date('2026-10-14T10:00:00.000Z');
function command() {
  return {
    commandId: randomUUID(),
    action: 'suspend',
    target: { scope: 'global', id: '*', version: null },
    reason: 'Emergency stop',
    expiresAt: null,
    expectedRevision: 0,
  };
}
function world(roles: readonly AppRole[] = ['Admin']) {
  const ledger = createMemorySuspensionLedger();
  const subjects: string[] = [];
  const deps = {
    ledger,
    now: () => at,
    verify: (assertion: string | undefined) =>
      assertion === undefined
        ? Promise.reject(new Unauthenticated('missing'))
        : Promise.resolve({ sub: 'alice', assertion } as Caller),
    rolesFor: (subject: string) => {
      subjects.push(subject);
      return Promise.resolve(roles);
    },
  };
  return { ledger, subjects, routes: { ...adminReadRoutes(deps), ...adminChangeRoutes(deps) } };
}
function request(body: unknown, headers: Record<string, string> = {}) {
  return {
    method: 'POST',
    path: '/v1/admin/suspensions',
    headers: {
      'content-type': 'application/json',
      'x-goog-iap-jwt-assertion': 'signed-alice',
      ...headers,
    },
    body: Buffer.from(JSON.stringify(body)),
  };
}
function route(routes: Readonly<Record<string, Route>>, name: string): Route {
  const found = Object.entries(routes).find(([key]) => key === name)?.[1];
  if (found === undefined) throw new Error('route');
  return found;
}
describe('trusted admin API', () => {
  test.each([{ roles: [] }, { roles: ['Employee'] }, { roles: ['Reviewer'] }] as {
    roles: AppRole[];
  }[])('non-admin $roles is forbidden before reading or writing state', async ({ roles }) => {
    const app = world(roles);
    const result = await route(app.routes, 'POST /v1/admin/suspensions')(request(command()));
    expect(result.status).toBe(403);
    expect(await app.ledger.history()).toEqual([]);
    expect(app.subjects).toEqual(['alice']);
  });
  test.each(['x-app-role', 'x-role', 'role', 'x-admin'])(
    'forged %s header cannot grant admin',
    async (header) => {
      const app = world(['Employee']);
      expect(
        (
          await route(
            app.routes,
            'POST /v1/admin/suspensions',
          )(request({ ...command(), role: 'Admin', actorSub: 'admin' }, { [header]: 'Admin' }))
        ).status,
      ).toBe(403);
      expect(await app.ledger.history()).toEqual([]);
    },
  );
  test('verified subject, not client actor, is the recorded admin', async () => {
    const app = world();
    const handler = route(app.routes, 'POST /v1/admin/suspensions');
    expect((await handler(request({ ...command(), actorSub: 'bob' }))).status).toBe(400);
    expect((await handler(request(command()))).status).toBe(200);
    expect((await app.ledger.history())[0].actorSub).toBe('alice');
  });
  test('every change produces exactly one event, including retries, suspension, resume and lifecycle', async () => {
    const app = world();
    const handler = route(app.routes, 'POST /v1/admin/suspensions');
    const stop = command();
    expect((await handler(request(stop))).status).toBe(200);
    expect((await handler(request(stop))).status).toBe(200);
    expect(await app.ledger.history()).toHaveLength(1);
    expect(
      (
        await handler(
          request({ ...stop, commandId: randomUUID(), action: 'resume', expectedRevision: 1 }),
        )
      ).status,
    ).toBe(200);
    const version = route(app.routes, 'POST /v1/admin/versions');
    for (const [index, state] of ['draft', 'published', 'deprecated', 'revoked'].entries()) {
      expect(
        (
          await version(
            request({
              commandId: randomUUID(),
              pin: { kind: 'tool', id: 'ticket.create', version: '1' },
              state,
              reason: 'Release',
              expectedRevision: index,
            }),
          )
        ).status,
      ).toBe(200);
      expect(await app.ledger.history()).toHaveLength(index + 3);
    }
  });
  test('stale revisions and illegal transitions return conflict and do not audit a change', async () => {
    const app = world();
    const handler = route(app.routes, 'POST /v1/admin/suspensions');
    await handler(request(command()));
    expect((await handler(request(command()))).status).toBe(409);
    expect(await app.ledger.history()).toHaveLength(1);
  });
  test.each(['GET /v1/admin/suspensions', 'GET /v1/admin/history'])(
    '%s is also directory restricted',
    async (name) => {
      expect((await route(world([]).routes, name)(request({}))).status).toBe(403);
      expect((await route(world().routes, name)(request({}))).status).toBe(200);
    },
  );
  test('missing assertion returns 401 without consulting client roles', async () => {
    const app = world();
    const req = request(command());
    Reflect.deleteProperty(req.headers, 'x-goog-iap-jwt-assertion');
    expect((await route(app.routes, 'POST /v1/admin/suspensions')(req)).status).toBe(401);
    expect(app.subjects).toEqual([]);
  });
  test('store outage returns 503 and changes no state', async () => {
    const app = world();
    app.ledger.change = () => Promise.reject(new Error('database unreachable'));
    expect((await route(app.routes, 'POST /v1/admin/suspensions')(request(command()))).status).toBe(
      503,
    );
    expect(await app.ledger.history()).toEqual([]);
  });
  test.each(['text/plain', 'application/x-www-form-urlencoded'])(
    'browser simple content type %s is rejected',
    async (contentType) => {
      const app = world();
      expect(
        (
          await route(
            app.routes,
            'POST /v1/admin/suspensions',
          )(request(command(), { 'content-type': contentType }))
        ).status,
      ).toBe(415);
    },
  );
  test.each([
    {},
    null,
    [],
    { ...command(), target: { scope: 'global', id: 'all', version: null } },
  ])('invalid command is rejected', async (body) => {
    const app = world();
    expect((await route(app.routes, 'POST /v1/admin/suspensions')(request(body))).status).toBe(400);
    expect(await app.ledger.history()).toEqual([]);
  });
});
