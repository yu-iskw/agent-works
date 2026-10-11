import { createHash } from 'node:crypto';

import { TASK_STATUSES, oauthStartSchema, taskSchema, transition } from '@agent-works/domain';
import { createOAuth, listen } from '@agent-works/fakes';
import { afterEach, expect, it } from 'vitest';

import { createMemoryCredentialsPort } from '../ports/memory/credentials.js';
import { createOAuthConnectRoute, createOAuthRevokeRoute } from '../routes/oauth.js';

import { OAuthDenied, createOAuthFlow } from './flow.js';
import { createHttpOAuthProvider } from './provider.js';

import type { OAuthFlow } from './flow.js';
import type { GrantStore, OAuthGrant } from './grant.js';
import type { Route } from '../http.js';
import type { CredentialsPort } from '../ports/credentials.js';
import type { OAuthConnection, OAuthStart, OutboxEvent, Task } from '@agent-works/domain';

const verifier = 'verifier-value-which-is-long-enough';
const challenge = createHash('sha256').update(verifier).digest('base64url');
const canary = 'canary-do-not-log';
const activeUntil = '2099-01-01T00:00:00.000Z';

const closers: { close(): Promise<void> }[] = [];

afterEach(async () => {
  const pending = closers.splice(0);
  for (const closer of pending) await closer.close();
});

it('rejects a callback whose state was never issued', async () => {
  const { flow, credentials, url } = await openFlow();
  const start = startFor('state-1');
  await flow.begin('alice', start);
  const code = await authorize(url, 'state-1');
  const error = await denied(() =>
    flow.complete('alice', {
      provider: 'fake',
      state: 'other-state',
      code,
      codeVerifier: verifier,
    }),
  );
  expect(error.code).toBe('state_mismatch');
  expect(await credentials.read('alice', 'fake')).toBeUndefined();
  expect(
    await flow.complete('alice', {
      provider: 'fake',
      state: 'state-1',
      code,
      codeVerifier: verifier,
    }),
  ).toEqual(activeConnection());
});

it('rejects a verifier that does not match the stored challenge', async () => {
  const { flow, credentials, url } = await openFlow();
  await flow.begin('alice', startFor('state-1'));
  const code = await authorize(url, 'state-1');
  const error = await denied(() =>
    flow.complete('alice', {
      provider: 'fake',
      state: 'state-1',
      code,
      codeVerifier: 'not-the-verifier',
    }),
  );
  expect(error.code).toBe('pkce_mismatch');
  expect(await credentials.read('alice', 'fake')).toBeUndefined();
  expect(
    await flow.complete('alice', {
      provider: 'fake',
      state: 'state-1',
      code,
      codeVerifier: verifier,
    }),
  ).toEqual(activeConnection());
});

it('stores the connection and leaves the provider secret behind', async () => {
  const { flow, credentials, url } = await openFlow();
  const saved = await connect(flow, url, 'state-1');
  expect(saved).toEqual(activeConnection());
  expect(JSON.stringify(saved).includes(canary)).toBe(false);
  expect(await credentials.read('alice', 'fake')).toEqual(activeConnection());
  const proof = await exchange(url, 'state-2');
  expect(proof.token).toBe(canary);
  expect(JSON.stringify(await credentials.read('alice', 'fake')).includes(canary)).toBe(false);
});

it('revoke marks the connection revoked and still omits the secret', async () => {
  const { flow, url } = await openFlow();
  await connect(flow, url, 'state-1');
  const route = createOAuthRevokeRoute({ flow, subject: () => 'alice' });
  expect(await route(call('DELETE', '/v1/oauth/connections/fake'))).toEqual({
    status: 200,
    body: { kind: 'connection', ...activeConnection(), status: 'revoked' },
  });
  expect(JSON.stringify(await flow.revoke('alice', 'fake')).includes(canary)).toBe(false);
});

it('an active connection leaves the running task alone', async () => {
  const { flow, url, task, events } = await openFlow();
  await connect(flow, url, 'state-1');
  expect(await flow.blockIfStale('alice', 'fake', 'task-1')).toEqual(runningTask());
  expect(task()?.status).toBe('RUNNING');
  expect(events).toEqual([]);
});

it('an expired connection blocks the running task', async () => {
  const { flow, credentials, url, events, setNow } = await openFlow();
  await connect(flow, url, 'state-1');
  setNow('2100-01-01T00:00:00.000Z');
  expect(await flow.blockIfStale('alice', 'fake', 'task-1')).toEqual({
    ...runningTask(),
    status: 'BLOCKED_AUTH',
    version: 2,
    updatedAt: '2100-01-01T00:00:00.000Z',
  });
  expect(await credentials.read('alice', 'fake')).toEqual({
    ...activeConnection(),
    status: 'expired',
  });
  expect(events).toEqual([
    {
      destination: 'work',
      event: {
        eventId: 'auth-task-1-1',
        eventType: 'oauth.blocked',
        schemaVersion: '1',
        occurredAt: '2100-01-01T00:00:00.000Z',
        taskId: 'task-1',
        stepId: 'oauth',
        traceId: 'task-1',
        initiatorSubject: 'alice',
        agentPrincipal: 'credentials',
        tool: null,
        policyDecisionId: null,
        approvalId: null,
        requestDigestSha256: null,
        outcome: 'BLOCKED_AUTH',
        externalObjectRef: 'token-1',
        prevDigest: null,
      },
    },
  ]);
  expect(JSON.stringify(events).includes(canary)).toBe(false);
  expect(await flow.blockIfStale('alice', 'fake', 'task-1')).toMatchObject({
    status: 'BLOCKED_AUTH',
    version: 2,
  });
});

it('a different subject cannot spend the grant', async () => {
  const { flow, url } = await openFlow();
  await flow.begin('alice', startFor('state-1'));
  const code = await authorize(url, 'state-1');
  const error = await denied(() =>
    flow.complete('bob', {
      provider: 'fake',
      state: 'state-1',
      code,
      codeVerifier: verifier,
    }),
  );
  expect(error.code).toBe('state_mismatch');
  expect(
    await flow.complete('alice', {
      provider: 'fake',
      state: 'state-1',
      code,
      codeVerifier: verifier,
    }),
  ).toEqual(activeConnection());
});

it.each(TASK_STATUSES.filter((status) => status !== 'RUNNING'))(
  'an expired connection leaves a %s task alone',
  async (status) => {
    const initial = { ...runningTask(), status };
    const { flow, url, task, events, setNow } = await openFlow(initial);
    await connect(flow, url, 'state-1');
    setNow('2100-01-01T00:00:00.000Z');
    expect(await flow.blockIfStale('alice', 'fake', 'task-1')).toEqual(initial);
    expect(task()).toEqual(initial);
    expect(events).toEqual([]);
  },
);

it('rejects domain-wide delegation before a grant is stored', async () => {
  const { flow, credentials } = await openFlow();
  const route = createOAuthConnectRoute({ flow, subject: () => 'alice' });
  expect(
    await route(
      call('POST', '/v1/oauth/connections/fake', {
        kind: 'start',
        ...startFor('state-1'),
        delegation: 'domain',
      }),
    ),
  ).toEqual({ status: 400, body: { error: 'invalid_request' } });
  expect(await credentials.read('alice', 'fake')).toBeUndefined();
  const error = await denied(() =>
    flow.complete('alice', {
      provider: 'fake',
      state: 'state-1',
      code: 'code-1',
      codeVerifier: verifier,
    }),
  );
  expect(error.code).toBe('state_mismatch');
});

it('begin returns the pkce start and callback returns the connection', async () => {
  const { flow, url } = await openFlow();
  const connect = createOAuthConnectRoute({ flow, subject: () => 'alice' });
  const start = startFor('state-1');
  expect(
    await connect(call('POST', '/v1/oauth/connections/fake', { kind: 'start', ...start })),
  ).toEqual({ status: 200, body: { kind: 'start', ...start } });
  const code = await authorize(url, 'state-1');
  expect(
    await connect(
      call('POST', '/v1/oauth/connections/fake', {
        kind: 'callback',
        provider: 'fake',
        state: 'state-1',
        code,
        codeVerifier: verifier,
      }),
    ),
  ).toEqual({ status: 200, body: { kind: 'connection', ...activeConnection() } });
});

it('missing subject is unauthenticated', async () => {
  const { flow } = await openFlow();
  const connect = createOAuthConnectRoute({ flow, subject: () => undefined });
  const revoke = createOAuthRevokeRoute({ flow, subject: () => undefined });
  expect(
    await connect(
      call('POST', '/v1/oauth/connections/fake', { kind: 'start', ...startFor('state-1') }),
    ),
  ).toEqual({ status: 401, body: { error: 'unauthenticated' } });
  expect(await revoke(call('DELETE', '/v1/oauth/connections/fake'))).toEqual({
    status: 401,
    body: { error: 'unauthenticated' },
  });
});

it('revoke of an unknown connection is not found', async () => {
  const { flow } = await openFlow();
  const route = createOAuthRevokeRoute({ flow, subject: () => 'alice' });
  expect(await route(call('DELETE', '/v1/oauth/connections/fake'))).toEqual({
    status: 404,
    body: { error: 'not_found' },
  });
});

type FlowHandle = {
  readonly flow: OAuthFlow;
  readonly credentials: CredentialsPort;
  readonly url: string;
  readonly events: OutboxEvent[];
  readonly task: () => Task | undefined;
  readonly setNow: (iso: string) => void;
};

async function openFlow(initialTask: Task = runningTask()): Promise<FlowHandle> {
  const credentials = createMemoryCredentialsPort();
  const grants = memoryGrants();
  const events: OutboxEvent[] = [];
  let task: Task | undefined = initialTask;
  let instant = new Date('2026-10-10T00:00:00.000Z');
  const server = await listen(createOAuth(), 0);
  closers.push(server);
  const flow = createOAuthFlow({
    credentials,
    grants,
    provider: createHttpOAuthProvider(server.url),
    ledger: {
      read(subject, taskId) {
        if (task === undefined || task.id !== taskId || task.createdBySub !== subject) {
          return Promise.resolve(undefined);
        }
        return Promise.resolve(task);
      },
      transition(input) {
        if (task === undefined || task.id !== input.taskId || task.createdBySub !== input.subject) {
          return Promise.reject(new Error('missing'));
        }
        const next = transition(task, input.to);
        task = { ...next, updatedAt: input.event.event.occurredAt };
        events.push(input.event);
        return Promise.resolve(task);
      },
    },
    now: () => instant,
  });
  return {
    flow,
    credentials,
    url: server.url,
    events,
    task: () => task,
    setNow(iso) {
      instant = new Date(iso);
    },
  };
}

function memoryGrants(): GrantStore {
  const grants = new Map<string, OAuthGrant>();
  return {
    save(grant) {
      grants.set(grant.state, grant);
      return Promise.resolve();
    },
    read(state) {
      return Promise.resolve(grants.get(state));
    },
    consume(state) {
      const grant = grants.get(state);
      grants.delete(state);
      return Promise.resolve(grant);
    },
  };
}

function startFor(state: string): OAuthStart {
  return oauthStartSchema.parse({
    provider: 'fake',
    state,
    codeChallenge: challenge,
    codeChallengeMethod: 'S256',
    scope: 'ticket.create',
  });
}

function activeConnection(): OAuthConnection {
  return {
    provider: 'fake',
    subject: 'alice',
    scope: 'ticket.create',
    status: 'active',
    expiresAt: activeUntil,
    tokenRef: 'token-1',
  };
}

function runningTask(): Task {
  return taskSchema.parse({
    id: 'task-1',
    createdBySub: 'alice',
    status: 'RUNNING',
    objectiveDigest: 'digest',
    skillVersion: 'ask',
    agentVersion: 'test',
    policyVersion: 'test',
    budget: 0.1,
    version: 1,
    createdAt: '2026-10-10T00:00:00.000Z',
    updatedAt: '2026-10-10T00:00:00.000Z',
  });
}

async function connect(flow: OAuthFlow, url: string, state: string): Promise<OAuthConnection> {
  await flow.begin('alice', startFor(state));
  const code = await authorize(url, state);
  return flow.complete('alice', {
    provider: 'fake',
    state,
    code,
    codeVerifier: verifier,
  });
}

async function authorize(url: string, state: string): Promise<string> {
  const response = await fetch(`${url}/oauth/authorize`, {
    method: 'POST',
    body: JSON.stringify({ subject: 'alice', ...startFor(state) }),
  });
  const body: unknown = await response.json();
  if (!isRecord(body) || typeof body.code !== 'string') throw new Error('code');
  return body.code;
}

async function exchange(url: string, state: string): Promise<{ token: string }> {
  const code = await authorize(url, state);
  const response = await fetch(`${url}/oauth/token`, {
    method: 'POST',
    body: JSON.stringify({
      provider: 'fake',
      state,
      code,
      codeVerifier: verifier,
    }),
  });
  const body: unknown = await response.json();
  if (!isRecord(body) || typeof body.token !== 'string') throw new Error('token');
  return { token: body.token };
}

async function denied(run: () => Promise<unknown>): Promise<OAuthDenied> {
  try {
    await run();
  } catch (error) {
    if (error instanceof OAuthDenied) return error;
    throw error;
  }
  throw new Error('expected denial');
}

function call(method: string, path: string, body?: unknown): Parameters<Route>[0] {
  return {
    method,
    path,
    headers: {},
    body: body === undefined ? Buffer.alloc(0) : Buffer.from(JSON.stringify(body)),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
