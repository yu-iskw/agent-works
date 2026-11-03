import { describe, expect, it, vi } from 'vitest';

import { createMemoryAuditLog } from '../audit/write.js';
import { Unauthenticated } from '../auth/iap.js';
import { createMemorySuspensionLedger } from '../ports/memory/suspension-ledger.js';
import { createRouteTable } from '../routes/index.js';

import type { AppRole } from '../auth/directory.js';
import type { Caller } from '../auth/iap.js';
import type { AskDeps } from '../routes/ask.js';
import type { RouteDeps } from '../routes/index.js';

const now = new Date('2026-11-03T00:00:00Z');
const base: AskDeps = {
  verify: (assertion) =>
    assertion === undefined
      ? Promise.reject(new Unauthenticated('missing'))
      : Promise.resolve({ sub: assertion, assertion } as Caller),
  drive: { retrieve: () => Promise.reject(new Error('unused')) },
  runner: { run: () => Promise.reject(new Error('unused')) },
  audit: createMemoryAuditLog(),
  now: () => now,
};
const report = { outstanding: [], uncertain: [], completed: [] };
const get = (sub?: string) => ({
  method: 'GET',
  path: '/x',
  headers: sub === undefined ? {} : { 'x-goog-iap-jwt-assertion': sub },
  body: Buffer.alloc(0),
});

function table(extra: Partial<RouteDeps> = {}, roles: readonly AppRole[] = ['Admin']) {
  const ledger = createMemorySuspensionLedger();
  const routes = createRouteTable(
    {
      ...base,
      admin: { ledger, rolesFor: () => Promise.resolve(roles), now: () => now },
      ...extra,
    },
    {},
  );
  return { ledger, routes };
}

describe('default off', () => {
  it('registers none of the new routes without their dependencies', () => {
    const keys = Object.keys(createRouteTable({ ...base }, {}));
    expect(keys).not.toContain('GET /v1/admin/outstanding');
    expect(keys).not.toContain('POST /v1/ops/dashboard');
    expect(keys).not.toContain('POST /internal/deliveries');
  });

  it('keeps the admin routes without the outstanding route when it is not supplied', () => {
    const { routes } = table();
    expect(Object.keys(routes)).toContain('GET /v1/admin/suspensions');
    expect(Object.keys(routes)).not.toContain('GET /v1/admin/outstanding');
  });
});

describe('outstanding operations route', () => {
  it('returns the report to an Admin', async () => {
    const outstanding = vi.fn(() => Promise.resolve(report));
    const { routes } = table({ outstanding });
    const reply = await routes['GET /v1/admin/outstanding'](get('root'));
    expect(reply).toEqual({ status: 200, body: report });
  });

  it('refuses a non-Admin, never reads the ledger, and records the denial', async () => {
    const outstanding = vi.fn(() => Promise.resolve(report));
    const { routes, ledger } = table({ outstanding }, ['Employee']);
    const reply = await routes['GET /v1/admin/outstanding'](get('mallory'));
    expect(reply.status).toBe(403);
    expect(outstanding).not.toHaveBeenCalled();
    expect((await ledger.history()).at(-1)).toMatchObject({
      eventType: 'invocation.denied',
      actorSub: 'mallory',
    });
  });

  it('answers 401 with no assertion', async () => {
    const { routes } = table({ outstanding: () => Promise.resolve(report) });
    expect((await routes['GET /v1/admin/outstanding'](get())).status).toBe(401);
  });
});

describe('audited admin denials', () => {
  it('records a non-Admin attempt on the existing change route', async () => {
    const { routes, ledger } = table({}, ['Employee']);
    const reply = await routes['GET /v1/admin/suspensions'](get('mallory'));
    expect(reply.status).toBe(403);
    expect(await ledger.history()).toHaveLength(1);
  });

  it('writes nothing for an Admin read', async () => {
    const { routes, ledger } = table();
    expect((await routes['GET /v1/admin/suspensions'](get('root'))).status).toBe(200);
    expect(await ledger.history()).toHaveLength(0);
  });
});

describe('mounted when supplied', () => {
  it('mounts the internal table and the ops dashboard', () => {
    const internal = {
      'POST /internal/deliveries': () => Promise.resolve({ status: 200, body: {} }),
    };
    const opsDashboard = {
      verify: base.verify,
      authority: () =>
        Promise.resolve({
          memberId: 'm',
          ownedBotIds: [],
          adminSegmentIds: [],
          platformAdmin: false,
        }),
      service: {} as never,
    };
    const keys = Object.keys(createRouteTable({ ...base, internal, opsDashboard }, {}));
    expect(keys).toEqual(
      expect.arrayContaining([
        'POST /internal/deliveries',
        'POST /v1/ops/dashboard',
        'POST /v1/ops/dashboard/reconcile',
      ]),
    );
  });
});
