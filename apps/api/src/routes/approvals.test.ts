import { IAP_ASSERTION_HEADER, approvalSchema } from '@agent-works/domain';
import { expect, it } from 'vitest';

import { Unauthenticated, Unavailable } from '../auth/iap.js';
import { createMemoryApprovalStore } from '../broker/approvals.js';
import { TICKET_TOOL } from '../broker/broker.js';

import { approvalsDecideSlot } from './approvals-decide.js';
import { createApprovalsRoute } from './approvals.js';
import { selectRoute } from './slot.js';

import type { AppRole } from '../auth/directory.js';
import type { Caller, VerifyAssertion } from '../auth/iap.js';
import type { ApprovalStore } from '../broker/approvals.js';
import type { Route } from '../http.js';
import type { Approval } from '@agent-works/domain';

const digest = 'a'.repeat(64);
const otherDigest = 'b'.repeat(64);
const approvalId = 'apr-1';
const csrfHeader = 'x-csrf-token';

function caller(sub: string): Caller {
  return { sub, assertion: sub } as Caller;
}

function pendingApproval(): Approval {
  return approvalSchema.parse({
    id: approvalId,
    taskId: 'tsk-1',
    stepId: 'step-1',
    tool: TICKET_TOOL,
    targetResource: 'PROJ',
    payloadSha256: digest,
    requestedBySub: 'alice',
    approverSub: null,
    state: 'pending',
    expiresAt: '2026-12-01T00:00:00.000Z',
    maxExecutions: 1,
    executionsUsed: 0,
  });
}

function verifyCaller(): VerifyAssertion {
  return (assertion) => Promise.resolve(caller(assertion ?? 'missing'));
}

async function world(roles: readonly AppRole[] = ['Reviewer']): Promise<{
  readonly route: Route;
  readonly store: ApprovalStore;
}> {
  const store = createMemoryApprovalStore();
  await store.save(pendingApproval());
  return {
    store,
    route: createApprovalsRoute({
      store,
      verify: verifyCaller(),
      rolesFor: () => Promise.resolve(roles),
    }),
  };
}

function call(
  route: Route,
  input: {
    readonly sub: string;
    readonly decision: 'approve' | 'reject';
    readonly expectedPayloadSha256: string;
    readonly csrf?: string;
  },
): Promise<{ readonly status: number; readonly body: unknown }> {
  const headers =
    input.csrf === undefined
      ? { [IAP_ASSERTION_HEADER]: input.sub }
      : { [IAP_ASSERTION_HEADER]: input.sub, [csrfHeader]: input.csrf };
  return route({
    method: 'POST',
    path: `/v1/approvals/${approvalId}:decide`,
    headers,
    body: Buffer.from(
      JSON.stringify({
        kind: 'decide',
        decision: input.decision,
        expectedPayloadSha256: input.expectedPayloadSha256,
      }),
    ),
  });
}

it('selects the decide route only when AW_APPROVALS=real', () => {
  expect(selectRoute(approvalsDecideSlot, {})).toBe(approvalsDecideSlot.stub);
  const route = createApprovalsRoute({
    store: createMemoryApprovalStore(),
    verify: verifyCaller(),
  });
  expect(selectRoute({ ...approvalsDecideSlot, real: route }, { AW_APPROVALS: 'real' })).toBe(
    route,
  );
});

it('CSRF-missing', async () => {
  const { route, store } = await world();
  expect(
    await call(route, { sub: 'bob', decision: 'approve', expectedPayloadSha256: digest }),
  ).toEqual({ status: 403, body: { error: 'csrf_missing' } });
  expect(await store.read(approvalId)).toMatchObject({ state: 'pending', approverSub: null });
  expect(
    await call(route, {
      sub: 'bob',
      decision: 'reject',
      expectedPayloadSha256: digest,
      csrf: 'token-1',
    }),
  ).toEqual({
    status: 200,
    body: { kind: 'decided', id: approvalId, state: 'rejected', executionsUsed: 0 },
  });
});

it('stale-digest', async () => {
  const { route, store } = await world();
  expect(
    await call(route, {
      sub: 'bob',
      decision: 'approve',
      expectedPayloadSha256: otherDigest,
      csrf: 'token-1',
    }),
  ).toEqual({ status: 409, body: { error: 'stale_digest' } });
  expect(await store.read(approvalId)).toMatchObject({
    state: 'pending',
    approverSub: null,
    payloadSha256: digest,
  });
  expect(
    await call(route, {
      sub: 'bob',
      decision: 'approve',
      expectedPayloadSha256: digest,
      csrf: 'token-1',
    }),
  ).toEqual({
    status: 200,
    body: { kind: 'decided', id: approvalId, state: 'approved', executionsUsed: 0 },
  });
});

it('rejects the requester and lets another reviewer approve', async () => {
  const { route, store } = await world();
  expect(
    await call(route, {
      sub: 'alice',
      decision: 'approve',
      expectedPayloadSha256: digest,
      csrf: 'token-1',
    }),
  ).toEqual({ status: 403, body: { error: 'self_approval' } });
  expect(await store.read(approvalId)).toMatchObject({ state: 'pending', approverSub: null });
  expect(
    await call(route, {
      sub: 'bob',
      decision: 'approve',
      expectedPayloadSha256: digest,
      csrf: 'token-1',
    }),
  ).toEqual({
    status: 200,
    body: { kind: 'decided', id: approvalId, state: 'approved', executionsUsed: 0 },
  });
  expect(await store.read(approvalId)).toMatchObject({ state: 'approved', approverSub: 'bob' });
});

it('rejects a caller who is no longer a reviewer', async () => {
  const { route, store } = await world([]);
  expect(
    await call(route, {
      sub: 'bob',
      decision: 'approve',
      expectedPayloadSha256: digest,
      csrf: 'token-1',
    }),
  ).toEqual({ status: 403, body: { error: 'forbidden' } });
  expect(await store.read(approvalId)).toMatchObject({ state: 'pending', approverSub: null });
});

it.each([
  { sub: 'alice', roles: [], status: 200 },
  { sub: 'bob', roles: ['Reviewer'], status: 200 },
  { sub: 'bob', roles: [], status: 403 },
  { sub: 'bob', roles: ['Admin'], status: 403 },
] as const)(
  'approval read checks ownership and roles: $sub $roles',
  async ({ sub, roles, status }) => {
    const { route, store } = await world(roles);
    const reply = await route({
      method: 'GET',
      path: '/v1/approvals/apr-1',
      headers: { [IAP_ASSERTION_HEADER]: sub },
      body: Buffer.alloc(0),
    });
    expect(reply.status).toBe(status);
    if (status === 200)
      expect(reply.body).toEqual({
        kind: 'detail',
        id: approvalId,
        actionSummary: `${TICKET_TOOL} on PROJ`,
        requestedBySub: 'alice',
        payloadSha256: digest,
        state: 'pending',
        expiresAt: pendingApproval().expiresAt,
      });
    expect(await store.read(approvalId)).toEqual(pendingApproval());
  },
);

it('returns not found for a missing approval', async () => {
  const { route } = await world();
  expect(
    await route({
      method: 'GET',
      path: '/v1/approvals/missing',
      headers: {},
      body: Buffer.alloc(0),
    }),
  ).toEqual({ status: 404, body: { error: 'not_found' } });
});

it.each([
  { error: new Unauthenticated('missing'), status: 401 },
  { error: new Unavailable('unavailable'), status: 503 },
])('approval read handles authentication failure $status', async ({ error, status }) => {
  const route = createApprovalsRoute({
    store: createMemoryApprovalStore(),
    verify: () => Promise.reject(error),
  });
  expect(
    (
      await route({
        method: 'GET',
        path: '/v1/approvals/apr-1',
        headers: {},
        body: Buffer.alloc(0),
      })
    ).status,
  ).toBe(status);
});
