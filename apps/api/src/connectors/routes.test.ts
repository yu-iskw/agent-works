import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { Unauthenticated } from '../auth/iap.js';

import { workspaceRoutes } from './routes.js';
import {
  connection,
  fixtureNow,
  listPayload,
  workspaceCall,
  workspaceHarness,
} from './test-fixtures.js';

import type { WorkspaceHarness } from './test-fixtures.js';
import type { Caller } from '../auth/iap.js';
import type { OAuthFlow } from '../credentials/flow.js';
import type { Route } from '../http.js';
let h: WorkspaceHarness;
let routes: Readonly<Record<string, Route>>;
let begin: ReturnType<typeof vi.fn<OAuthFlow['begin']>>;
beforeEach(async () => {
  h = await workspaceHarness();
  begin = vi.fn<OAuthFlow['begin']>((_subject, start) =>
    Promise.resolve({ ...start, authorizationUrl: 'http://127.0.0.1/authorize' }),
  );
  routes = workspaceRoutes({
    broker: h.broker,
    approvals: h.approvals,
    now: () => fixtureNow,
    verify: (assertion) =>
      assertion
        ? Promise.resolve({ sub: assertion, assertion } as Caller)
        : Promise.reject(new Unauthenticated('missing')),
    credentials: {
      read: (subject) => Promise.resolve(h.stored.get(subject)),
      save: (value) => Promise.resolve(value),
    },
    flow: { begin } as unknown as OAuthFlow,
    approverAuthorized: (subject) => subject === 'approver',
    authorizePreparation: (subject) => Promise.resolve(subject === 'alice'),
  });
});
afterEach(async () => {
  await h.close();
});
function request(path: string, body: unknown, subject = 'alice') {
  const route = new Map(Object.entries(routes)).get(`POST ${path}`);
  if (!route) throw new Error('route');
  return route({
    method: 'POST',
    path,
    headers: { 'x-goog-iap-jwt-assertion': subject },
    body: Buffer.from(JSON.stringify(body)),
  });
}
function executeBody() {
  return withoutSubject(workspaceCall({ tool: 'calendar.listEvents', payload: listPayload }));
}
describe('authenticated connector HTTP routes', () => {
  it('requires a verified caller for every endpoint', async () => {
    for (const key of Object.keys(routes)) {
      const result = await request(key.slice(5), {}, '');
      expect(result).toEqual({ status: 401, body: { error: 'AUTH_REQUIRED' } });
    }
  });
  it('derives caller identity from the verified assertion', async () => {
    const result = await request('/v1/connectors/execute', executeBody());
    expect(result.status).toBe(200);
    expect(JSON.stringify(result.body)).toContain('alice-event');
    expect(JSON.stringify(result.body)).not.toContain('bob-event');
  });
  it('rejects a forged outer subject in the route command', async () => {
    expect(await request('/v1/connectors/execute', { ...executeBody(), subject: 'bob' })).toEqual({
      status: 400,
      body: { error: 'INVALID_REQUEST' },
    });
  });
  it('returns a safe step-up response on missing scope', async () => {
    h.stored.set('alice', { ...connection(), scope: 'openid' });
    expect(await request('/v1/connectors/execute', executeBody())).toEqual({
      status: 409,
      body: { error: 'STEP_UP_REQUIRED' },
    });
  });
  it('prepares a payload and refuses decisions from a caller without approver authority', async () => {
    const body = withoutSubject(workspaceCall());
    const prepared = await request('/v1/connectors/approvals/prepare', body);
    expect(prepared.status).toBe(201);
    const data = prepared.body as { approval: { id: string; payloadSha256: string } };
    expect(
      await request('/v1/connectors/approvals/decide', {
        approvalId: data.approval.id,
        decision: 'approve',
        expectedPayloadSha256: data.approval.payloadSha256,
      }),
    ).toEqual({ status: 403, body: { error: 'POLICY_DENIED' } });
    const decided = await request(
      '/v1/connectors/approvals/decide',
      {
        approvalId: data.approval.id,
        decision: 'approve',
        expectedPayloadSha256: data.approval.payloadSha256,
      },
      'approver',
    );
    expect(decided.status).toBe(200);
    expect(
      await request('/v1/connectors/execute', { ...body, approvalId: data.approval.id }),
    ).toMatchObject({ status: 200, body: { kind: 'document' } });
  });
  it('does not expose another caller approval payload', async () => {
    const call = await h.approved();
    expect(
      await request('/v1/connectors/approvals/read', { approvalId: call.approvalId }, 'bob'),
    ).toEqual({ status: 403, body: { error: 'RESOURCE_DENIED' } });
    expect(
      (await request('/v1/connectors/approvals/read', { approvalId: call.approvalId })).status,
    ).toBe(200);
  });
  it('rejects stale digest decisions', async () => {
    const call = await h.approved();
    expect(
      await request(
        '/v1/connectors/approvals/decide',
        { approvalId: call.approvalId, decision: 'approve', expectedPayloadSha256: '0'.repeat(64) },
        'approver',
      ),
    ).toMatchObject({ status: 422, body: { error: 'APPROVAL_REQUIRED' } });
  });
  it('does not trust a client-supplied approver role', async () => {
    const call = await h.approved();
    const result = await request(
      '/v1/connectors/approvals/decide',
      {
        approvalId: call.approvalId,
        decision: 'approve',
        expectedPayloadSha256: '0'.repeat(64),
        role: 'Admin',
      },
      'bob',
    );
    expect(result.status).toBe(403);
  });
  it('uses trusted caller in scope step-up', async () => {
    const result = await request('/v1/connectors/scopes', {
      tool: 'gmail.searchThreads',
      state: 'new-state',
      codeChallenge: 'A'.repeat(43),
      codeChallengeMethod: 'S256',
    });
    expect(result.status).toBe(200);
    expect(begin).toHaveBeenCalledWith('alice', expect.objectContaining({ provider: 'google' }));
  });
  it('denies send before any external action', async () => {
    const result = await request('/v1/connectors/execute', {
      ...executeBody(),
      tool: 'gmail.send',
      payload: {},
    });
    expect(result).toEqual({ status: 403, body: { error: 'POLICY_DENIED' } });
    expect(h.gmail.drafts()).toEqual([]);
  });
});

function withoutSubject(call: ReturnType<typeof workspaceCall>) {
  const fields = new Map(Object.entries(call));
  fields.delete('subject');
  return Object.fromEntries(fields);
}
