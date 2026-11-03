import { afterAll, beforeAll, describe, expect, test } from 'vitest';

import { Unauthenticated } from '../auth/iap.js';
import { openSql, startDisposablePostgres } from '../ledger/disposable-postgres.js';
import { NOW, WINDOW, dockerAvailable, seedLedger } from '../ops-dashboard/seed.testkit.js';
import { createOpsDashboard } from '../ops-dashboard/service.js';

import { opsDashboardRoutes } from './ops-dashboard.js';

import type { VerifyAssertion } from '../auth/iap.js';
import type { DisposablePostgres } from '../ledger/disposable-postgres.js';
import type { OpsPrincipal } from '../ops-dashboard/types.js';
import type { Sql } from 'postgres';

const live = dockerAvailable();
let database: DisposablePostgres | undefined;
let sql: Sql;

const grantTable: Record<string, Omit<OpsPrincipal, 'subject'>> = {
  alice: { memberId: 'm1', ownedBotIds: [], adminSegmentIds: [], platformAdmin: false },
  bob: { memberId: 'm2', ownedBotIds: [], adminSegmentIds: [], platformAdmin: false },
  lead: { memberId: 'm9', ownedBotIds: [], adminSegmentIds: ['s1'], platformAdmin: false },
  eve: { memberId: 'm-eve', ownedBotIds: [], adminSegmentIds: [], platformAdmin: false },
};
const grants = new Map(Object.entries(grantTable));
const verify: VerifyAssertion = (assertion) => {
  if (assertion === undefined) return Promise.reject(new Unauthenticated('missing'));
  return Promise.resolve({ sub: assertion, assertion } as never);
};

beforeAll(async () => {
  if (!live) return;
  database = await startDisposablePostgres();
  sql = openSql(database.url);
  const { workerReady } = await import('../worker/migration.js');
  const { admissionReady } = await import('../admission/migration.js');
  await workerReady(sql);
  await admissionReady(sql);
  await seedLedger(sql);
}, 90_000);
afterAll(async () => {
  if (!live) return;
  await sql.end({ timeout: 1 });
  await database?.stop();
});

async function call(sub: string | undefined, body: unknown, path = 'POST /v1/ops/dashboard') {
  const routes = opsDashboardRoutes({
    verify,
    authority: (s) =>
      Promise.resolve(grants.get(s) ?? Promise.reject(new Error('unknown subject'))),
    service: createOpsDashboard({ sql, now: () => new Date(NOW) }),
  });
  // eslint-disable-next-line security/detect-object-injection -- test-controlled key
  return routes[path]({
    method: 'POST',
    path: path.split(' ')[1],
    headers: sub === undefined ? {} : { 'x-goog-iap-jwt-assertion': sub },
    body: Buffer.from(JSON.stringify(body)),
  });
}

describe.skipIf(!live)('ops dashboard routes', () => {
  test('401 without an assertion', async () => {
    expect((await call(undefined, {})).status).toBe(401);
  });
  test('a user sees their own scope', async () => {
    const reply = await call('alice', WINDOW);
    expect(reply.status).toBe(200);
    expect(JSON.stringify(reply.body)).toContain('"executions":2');
  });
  test('cross-user: bob never receives alice data', async () => {
    const reply = await call('bob', WINDOW);
    expect(JSON.stringify(reply.body)).toContain('"executions":1');
    expect(JSON.stringify(reply.body)).not.toContain('"estimatedMicros":1500');
  });
  test('forged scope is denied with 403 and no data', async () => {
    const reply = await call('bob', { scope: { kind: 'member', id: 'm1' }, ...WINDOW });
    expect(reply.status).toBe(403);
    expect(reply.body).toEqual({ error: 'forbidden_scope' });
  });
  test('outsider asking for a segment or all is denied', async () => {
    expect((await call('eve', { scope: { kind: 'segment', id: 's1' } })).status).toBe(403);
    expect((await call('eve', { scope: { kind: 'all', id: '' } })).status).toBe(403);
  });
  test('segment admin sees the segment', async () => {
    const reply = await call('lead', { scope: { kind: 'segment', id: 's1' }, ...WINDOW });
    expect(reply.status).toBe(200);
    expect(JSON.stringify(reply.body)).toContain('"executions":3');
  });
  test('reconcile route reports zero deltas', async () => {
    const reply = await call('alice', WINDOW, 'POST /v1/ops/dashboard/reconcile');
    expect(reply.status).toBe(200);
    expect((reply.body as { reconciliation: { ok: boolean } }).reconciliation.ok).toBe(true);
  });
  test('malformed and over-granting bodies are 400', async () => {
    expect((await call('alice', { scope: { kind: 'galaxy', id: 'x' } })).status).toBe(400);
    expect((await call('alice', { platformAdmin: true })).status).toBe(400);
  });
});
