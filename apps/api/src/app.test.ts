import { createHash } from 'node:crypto';
import { createServer } from 'node:http';

import { IAP_ASSERTION_HEADER } from '@agent-works/domain';
import { createOAuth, listen as listenFake } from '@agent-works/fakes';
import { describe, expect, it } from 'vitest';

import { createApp } from './app.js';
import { createMemoryAuditLog } from './audit/write.js';
import { Unauthenticated, Unavailable } from './auth/iap.js';
import { createMemoryApprovalStore, createPostgresApprovalStore } from './broker/approvals.js';
import { createApprovalHarness, useApprovalDatabase } from './broker/broker-harness.js';
import { TICKET_TOOL } from './broker/broker.js';
import { createOAuthFlow } from './credentials/flow.js';
import { createHttpOAuthProvider } from './credentials/provider.js';
import { createMemoryCredentialsPort } from './ports/memory/credentials.js';
import { createMemoryLedgerPort } from './ports/memory/ledger-port.js';

import type { Caller } from './auth/iap.js';
import type { ApprovalStore } from './broker/approvals.js';
import type { OAuthFlow } from './credentials/flow.js';
import type { OAuthGrant } from './credentials/grant.js';
import type { RequestListener } from 'node:http';

const digest = 'a'.repeat(64);
const path = '/v1/approvals/apr-1:decide';
const headers = { [IAP_ASSERTION_HEADER]: 'bob', 'x-csrf-token': 'token-1' };

function app(store: ApprovalStore, env = { AW_APPROVALS: 'real' }) {
  return createApp(
    {
      verify: () => Promise.resolve({ sub: 'bob', assertion: 'bob' } as Caller),
      drive: { retrieve: () => Promise.reject(new Error('unused')) },
      runner: { run: () => Promise.reject(new Error('unused')) },
      audit: createMemoryAuditLog(),
      now: () => new Date(0),
      approvals: { store, rolesFor: () => Promise.resolve(['Reviewer']) },
    },
    env,
  );
}

function decision(expectedPayloadSha256 = digest): string {
  return JSON.stringify({ kind: 'decide', decision: 'approve', expectedPayloadSha256 });
}

async function memoryStore(): Promise<ApprovalStore> {
  const store = createMemoryApprovalStore();
  await store.save({
    id: 'apr-1',
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
  return store;
}

it('round-trips a real decision at the body limit and replays it', async () => {
  const store = await memoryStore();
  const server = await listen(app(store), 0);
  try {
    for (const body of [decision().padEnd(16_384), decision()]) {
      const response = await fetch(`${server.url}${path}`, { method: 'POST', headers, body });
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({
        kind: 'decided',
        id: 'apr-1',
        state: 'approved',
        executionsUsed: 0,
      });
    }
    expect(await store.read('apr-1')).toMatchObject({ state: 'approved', approverSub: 'bob' });
  } finally {
    await server.close();
  }
});

it('rejects pattern bodies over the exact-route limit without deciding', async () => {
  const store = await memoryStore();
  const server = await listen(app(store), 0);
  try {
    const response = await fetch(`${server.url}${path}`, {
      method: 'POST',
      headers,
      body: decision().padEnd(16_385),
    });
    expect(response.status).toBe(413);
    expect(await response.json()).toEqual({ error: 'too_large' });
    expect(await store.read('apr-1')).toMatchObject({ state: 'pending', approverSub: null });
  } finally {
    await server.close();
  }
});

it('keeps approvals stubbed when the real route is disabled', async () => {
  const store = await memoryStore();
  const server = await listen(app(store, { AW_APPROVALS: 'stub' }), 0);
  try {
    const response = await fetch(`${server.url}${path}`, {
      method: 'POST',
      headers,
      body: decision(),
    });
    expect(response.status).toBe(501);
    expect(await store.read('apr-1')).toMatchObject({ state: 'pending', approverSub: null });
  } finally {
    await server.close();
  }
});

describe('Postgres approvals wiring', () => {
  const database = useApprovalDatabase();

  it('updates the durable approval used by the broker through an HTTP decision', async () => {
    const sql = database.sql();
    const harness = await createApprovalHarness(sql);
    const server = await listen(app(createPostgresApprovalStore(sql)), 0);
    try {
      await harness.save(harness.row({ state: 'pending', approverSub: null }));
      const response = await fetch(`${server.url}${path}`, {
        method: 'POST',
        headers,
        body: decision(harness.digest),
      });
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({
        kind: 'decided',
        id: 'apr-1',
        state: 'approved',
        executionsUsed: 0,
      });
      expect(await harness.read('apr-1')).toMatchObject({ state: 'approved', approverSub: 'bob' });
      expect(await harness.execute()).toEqual({ ok: true, receipt: 'FAKE-1', replay: false });
      expect(await harness.read('apr-1')).toMatchObject({ executionsUsed: 1 });
    } finally {
      await server.close();
      await harness.stop();
    }
  });
});

function listen(
  listener: RequestListener,
  port: number,
): Promise<{
  url: string;
  close(): Promise<void>;
}> {
  const server = createServer(listener);
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => {
      const address = server.address();
      if (address === null || typeof address === 'string') {
        reject(new Error('port'));
        return;
      }
      resolve({
        url: `http://127.0.0.1:${address.port}`,
        close: () =>
          new Promise((done, fail) => {
            server.close((error) => (error ? fail(error) : done()));
          }),
      });
    });
  });
}

it('dispatches the approval read route', async () => {
  const server = await listen(app(await memoryStore()), 0);
  try {
    const response = await fetch(`${server.url}/v1/approvals/apr-1`, { headers });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      kind: 'detail',
      id: 'apr-1',
      actionSummary: `${TICKET_TOOL} on PROJ`,
      requestedBySub: 'alice',
      payloadSha256: digest,
      state: 'pending',
      expiresAt: '2026-12-01T00:00:00.000Z',
    });
  } finally {
    await server.close();
  }
});

function oauthApp(flow: OAuthFlow, failure?: Error, enabled = true) {
  return createApp(
    {
      verify: (assertion) =>
        failure === undefined
          ? Promise.resolve({ sub: assertion ?? 'bob', assertion: assertion ?? 'bob' } as Caller)
          : Promise.reject(failure),
      drive: { retrieve: () => Promise.reject(new Error('unused')) },
      runner: { run: () => Promise.reject(new Error('unused')) },
      audit: createMemoryAuditLog(),
      now: () => new Date(0),
      oauth: flow,
    },
    { AW_OAUTH_CONNECT: enabled ? 'real' : 'stub', AW_OAUTH_REVOKE: enabled ? 'real' : 'stub' },
  );
}

it('dispatches OAuth start, callback, replay rejection and disconnect', async () => {
  const providerServer = await listenFake(createOAuth(), 0);
  const grants = new Map<string, OAuthGrant>();
  const credentials = createMemoryCredentialsPort();
  const flow = createOAuthFlow({
    credentials,
    grants: {
      save: (grant) => {
        grants.set(grant.state, grant);
        return Promise.resolve();
      },
      read: (state) => Promise.resolve(grants.get(state)),
      consume: (state) => {
        const grant = grants.get(state);
        grants.delete(state);
        return Promise.resolve(grant);
      },
    },
    provider: createHttpOAuthProvider(providerServer.url),
    ledger: { ...createMemoryLedgerPort(), transition: () => Promise.reject(new Error('unused')) },
    now: () => new Date(0),
  });
  const server = await listen(oauthApp(flow), 0);
  const endpoint = `${server.url}/v1/oauth/connections/fake`;
  const verifier = 'verifier-value-which-is-long-enough';
  const start = {
    provider: 'fake',
    state: 'state-1',
    codeChallenge: createHash('sha256').update(verifier).digest('base64url'),
    codeChallengeMethod: 'S256' as const,
    scope: 'ticket.create',
  };
  const post = (body: unknown, subject = 'bob') =>
    fetch(endpoint, {
      method: 'POST',
      headers: { [IAP_ASSERTION_HEADER]: subject },
      body: JSON.stringify(body),
    });
  try {
    const started = await post({ kind: 'start', ...start });
    expect(started.status).toBe(200);
    expect(await started.json()).toEqual({
      kind: 'started',
      ...start,
      authorizationUrl: createHttpOAuthProvider(providerServer.url).authorizationUrl(start),
    });
    const authorized = await fetch(`${providerServer.url}/oauth/authorize`, {
      method: 'POST',
      body: JSON.stringify({ subject: 'bob', ...start }),
    });
    const { code } = (await authorized.json()) as { code: string };
    const callback = {
      kind: 'callback',
      provider: 'fake',
      state: 'state-1',
      code,
      codeVerifier: verifier,
    };
    const wrongSubject = await post(callback, 'alice');
    expect(wrongSubject.status).toBe(400);
    expect(await wrongSubject.json()).toEqual({ error: 'state_mismatch' });
    const connected = await post(callback);
    expect(connected.status).toBe(200);
    expect(await connected.json()).toMatchObject({
      kind: 'connection',
      subject: 'bob',
      status: 'active',
    });
    const replay = await post(callback);
    expect(replay.status).toBe(400);
    expect(await replay.json()).toEqual({ error: 'state_mismatch' });
    const revoked = await fetch(endpoint, { method: 'DELETE', headers });
    expect(revoked.status).toBe(200);
    expect(await revoked.json()).toMatchObject({
      kind: 'connection',
      subject: 'bob',
      status: 'revoked',
    });
    expect(await credentials.read('bob', 'fake')).toMatchObject({ status: 'revoked' });
  } finally {
    await server.close();
    await providerServer.close();
  }
});

it.each([
  { failure: new Unauthenticated('missing'), status: 401, enabled: true },
  { failure: new Unavailable('unavailable'), status: 503, enabled: true },
  { failure: new Error('unused'), status: 501, enabled: false },
])('OAuth dispatcher handles verifier failure $status', async ({ failure, status, enabled }) => {
  const flow: OAuthFlow = {
    begin: () => Promise.reject(new Error('unused')),
    complete: () => Promise.reject(new Error('unused')),
    revoke: () => Promise.reject(new Error('unused')),
    blockIfStale: () => Promise.reject(new Error('unused')),
  };
  const server = await listen(oauthApp(flow, failure, enabled), 0);
  try {
    for (const method of ['POST', 'DELETE']) {
      const response = await fetch(`${server.url}/v1/oauth/connections/fake`, { method });
      expect(response.status).toBe(status);
    }
  } finally {
    await server.close();
  }
});
