import { randomUUID } from 'node:crypto';

import { expect, test } from 'vitest';

import { Unauthenticated } from '../auth/iap.js';
import { createMemorySuspensionLedger } from '../ports/memory/suspension-ledger.js';
import { adminChangeRoutes } from '../routes/admin-change.js';

import { adminRoleRequired, auditAdminDenials } from './admin-denial.js';
import { suspendCommand, testAt } from './test-fixtures.js';

import type { AppRole } from '../auth/directory.js';
import type { Caller } from '../auth/iap.js';

function world(roles: readonly AppRole[]) {
  const ledger = createMemorySuspensionLedger();
  const deps = {
    ledger,
    now: () => testAt,
    verify: (assertion: string | undefined) =>
      assertion === undefined
        ? Promise.reject(new Unauthenticated('missing'))
        : Promise.resolve({ sub: assertion, assertion } as Caller),
    rolesFor: () => Promise.resolve(roles),
  };
  return { ledger, routes: auditAdminDenials(adminChangeRoutes(deps), deps) };
}
function post(sub: string | undefined, body: unknown) {
  return {
    method: 'POST',
    path: '/v1/admin/suspensions',
    headers: {
      'content-type': 'application/json',
      ...(sub === undefined ? {} : { 'x-goog-iap-jwt-assertion': sub }),
    },
    body: Buffer.from(JSON.stringify(body)),
  };
}
const globalTarget = { scope: 'global', id: '*', version: null } as const;

test('an unauthorized resume is refused, leaves the stop in force, and records actor and reason', async () => {
  const app = world(['Employee']);
  const stop = suspendCommand(globalTarget);
  if (stop.kind !== 'suspension') throw new Error('fixture');
  await app.ledger.change(stop, 'operator', testAt);

  const reply = await app.routes['POST /v1/admin/suspensions'](
    post('mallory', {
      ...stop.command,
      commandId: randomUUID(),
      action: 'resume',
      expectedRevision: 1,
    }),
  );

  expect(reply.status).toBe(403);
  expect((await app.ledger.snapshot()).suspensions[0]).toMatchObject({ suspended: true });
  const denial = (await app.ledger.history()).at(-1);
  expect(denial).toMatchObject({
    eventType: 'invocation.denied',
    actorSub: 'mallory',
    reason: adminRoleRequired,
    details: { kind: 'admin', attempted: { action: 'resume', target: 'global:*' } },
  });
});

test('an unauthenticated resume attempt is refused without fabricating an actor', async () => {
  const app = world(['Employee']);
  const reply = await app.routes['POST /v1/admin/suspensions'](post(undefined, {}));
  expect(reply.status).toBe(401);
  expect(await app.ledger.history()).toEqual([]);
});

test('an authorized admin resume is not recorded as a denial', async () => {
  const app = world(['Admin']);
  const stop = suspendCommand(globalTarget);
  if (stop.kind !== 'suspension') throw new Error('fixture');
  await app.ledger.change(stop, 'operator', testAt);
  const reply = await app.routes['POST /v1/admin/suspensions'](
    post('alice', {
      ...stop.command,
      commandId: randomUUID(),
      action: 'resume',
      expectedRevision: 1,
    }),
  );
  expect(reply.status).toBe(200);
  expect(
    (await app.ledger.history()).filter((event) => event.eventType === 'invocation.denied'),
  ).toEqual([]);
});
