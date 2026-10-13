import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { readFileSync } from 'node:fs';

import { afterAll, beforeAll, expect, it } from 'vitest';
import * as z from 'zod';

import { createIapVerifier } from '../../apps/api/src/auth/iap.js';
import { createOAuthFlow } from '../../apps/api/src/credentials/flow.js';
import {
  applyCredentialsMigration,
  createPostgresCredentialStore,
} from '../../apps/api/src/credentials/postgres.js';
import { createHttpOAuthProvider } from '../../apps/api/src/credentials/provider.js';
import { openSql, startDisposablePostgres } from '../../apps/api/src/ledger/disposable-postgres.js';
import {
  applyTaskLedgerMigration,
  createPostgresLedgerPort,
} from '../../apps/api/src/ledger/postgres-ledger.js';
import {
  createOAuthConnectionsReadRoute,
  createPostgresOAuthConnectionsReader,
} from '../../apps/api/src/routes/oauth-connections-read.js';
import {
  createOAuthConnectRoute,
  createOAuthRevokeRoute,
} from '../../apps/api/src/routes/oauth.js';
import { oauthApiSchema } from '../../packages/domain/src/credentials.js';
import { createOAuth } from '../../packages/fakes/src/fake-oauth.js';
import { listen } from '../../packages/fakes/src/http.js';
import { appendResult } from '../results.mjs';

import type { DisposablePostgres } from '../../apps/api/src/ledger/disposable-postgres.js';
import type { OAuthStart, OutboxEvent, TaskSubmit } from '@agent-works/domain';

const verifier = 'verifier-value-which-is-long-enough';
const challenge = createHash('sha256').update(verifier).digest('base64url');
const canary = 'canary-do-not-log';
/* eslint-disable security/detect-non-literal-fs-filename -- fixed path to the published OAuth schema */
const published = z.fromJSONSchema(
  JSON.parse(readFileSync(new URL('../../contracts/schemas/oauth.json', import.meta.url), 'utf8')),
);
/* eslint-enable security/detect-non-literal-fs-filename */
const keys = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
const at = new Date('2026-10-10T10:00:00.000Z');

const submit: TaskSubmit = {
  objective: 'Summarize the runbook',
  skillId: 'ask',
  sourceAllowlist: ['drive'],
  requestedOutputs: ['answer'],
  executionPolicy: { mode: 'interactive', budgetUsd: 0.1, deadlineSeconds: 30 },
};

let database: DisposablePostgres | undefined;
let sql: ReturnType<typeof openSql> | undefined;
let closeOAuth: (() => Promise<void>) | undefined;

beforeAll(async () => {
  database = await startDisposablePostgres();
  sql = openSql(database.url);
  await applyCredentialsMigration(sql);
  await applyTaskLedgerMigration(sql);
}, 60_000);

afterAll(async () => {
  await closeOAuth?.();
  await sql?.end({ timeout: 1 });
  await database?.stop();
});

it('oauth.blocked-auth', async () => {
  if (sql === undefined) throw new Error('postgres');
  const server = await listen(createOAuth(), 0);
  closeOAuth = server.close;
  let instant = new Date('2026-10-10T10:00:00.000Z');
  const store = createPostgresCredentialStore(sql);
  const ledger = createPostgresLedgerPort(sql, () => at);
  const flow = createOAuthFlow({
    credentials: store.credentials,
    grants: store.grants,
    provider: createHttpOAuthProvider(server.url, 'https://app.example/oauth/callback'),
    ledger,
    now: () => instant,
  });
  const read = readConnections(sql, () => instant);
  expect(await read('alice')).toEqual({
    status: 200,
    body: { kind: 'connections', connections: [] },
  });
  const start: OAuthStart = {
    provider: 'fake',
    state: 'state-1',
    codeChallenge: challenge,
    codeChallengeMethod: 'S256',
    scope: 'ticket.create',
  };
  const started = await flow.begin('alice', start);
  expect(oauthApiSchema.parse({ kind: 'started', ...started })).toEqual({
    kind: 'started',
    ...start,
    authorizationUrl: createHttpOAuthProvider(
      server.url,
      'https://app.example/oauth/callback',
    ).authorizationUrl('alice', start),
  });
  const authorized = await fetch(started.authorizationUrl, { redirect: 'manual' });
  expect(authorized.status).toBe(302);
  const redirect = new URL(authorized.headers.get('location') ?? '');
  expect(redirect.origin + redirect.pathname).toBe('https://app.example/oauth/callback');
  expect(redirect.searchParams.get('state')).toBe(start.state);
  const code = redirect.searchParams.get('code');
  if (code === null || code.length === 0) throw new Error('code');
  const saved = await flow.complete('alice', {
    provider: 'fake',
    state: redirect.searchParams.get('state') ?? '',
    code,
    codeVerifier: verifier,
  });
  expect(saved).toEqual({
    provider: 'fake',
    subject: 'alice',
    scope: 'ticket.create',
    status: 'active',
    expiresAt: '2099-01-01T00:00:00.000Z',
    tokenRef: 'token-1',
  });
  expect(JSON.stringify(saved).includes(canary)).toBe(false);
  const publicConnection = {
    provider: saved.provider,
    scope: saved.scope,
    status: saved.status,
    expiresAt: saved.expiresAt,
  };
  expect(await read('alice')).toEqual({
    status: 200,
    body: { kind: 'connections', connections: [publicConnection] },
  });
  expect(await readConnections(sql, () => instant)('alice')).toEqual(await read('alice'));
  expect(await read('bob')).toEqual({
    status: 200,
    body: { kind: 'connections', connections: [] },
  });
  expect(await read()).toEqual({ status: 401, body: { error: 'unauthenticated' } });
  await expect(
    flow.complete('alice', {
      provider: 'fake',
      state: start.state,
      code,
      codeVerifier: verifier,
    }),
  ).rejects.toMatchObject({ code: 'state_mismatch' });

  const accepted = await ledger.submit('alice', submit, 'oauth-block');
  await ledger.transition({
    subject: 'alice',
    taskId: accepted.taskId,
    expectedVersion: 1,
    to: 'RUNNING',
    event: outbox('evt-run', accepted.taskId),
  });
  instant = new Date('2100-01-01T00:00:00.000Z');
  const blocked = await flow.blockIfStale('alice', 'fake', accepted.taskId);
  expect(blocked.status).toBe('BLOCKED_AUTH');
  expect(blocked.version).toBe(3);
  expect(await store.credentials.read('alice', 'fake')).toEqual({
    provider: 'fake',
    subject: 'alice',
    scope: 'ticket.create',
    status: 'expired',
    expiresAt: '2099-01-01T00:00:00.000Z',
    tokenRef: 'token-1',
  });
  const rows = await sql<{ payload: unknown }[]>`
    select payload from outbox_events where event_id = ${`auth-${accepted.taskId}-2`}
  `;
  expect(rows).toHaveLength(1);
  expect(JSON.stringify(rows[0]?.payload).includes(canary)).toBe(false);
  expect(await read('alice')).toMatchObject({ body: { connections: [{ status: 'expired' }] } });
  const routeDeps = { flow, subject: () => 'alice' };
  const revoke = createOAuthRevokeRoute(routeDeps);
  expect(
    await revoke({
      method: 'DELETE',
      path: '/v1/oauth/connections/fake',
      headers: {},
      body: Buffer.alloc(0),
    }),
  ).toMatchObject({ status: 200, body: { kind: 'connection', status: 'revoked' } });
  expect(await read('alice')).toMatchObject({ body: { connections: [{ status: 'revoked' }] } });
  instant = at;
  const connect = createOAuthConnectRoute(routeDeps);
  const restarted = await connect(
    oauthRequest({ kind: 'start', ...start, state: 'state-reconnect', scope: 'drive.read' }),
  );
  expect(restarted.status).toBe(200);
  const restartedBody = oauthApiSchema.parse(restarted.body);
  if (restartedBody.kind !== 'started') throw new Error('started');
  const consent = await fetch(restartedBody.authorizationUrl, { redirect: 'manual' });
  const callback = new URL(consent.headers.get('location') ?? '');
  const reconnected = await connect(
    oauthRequest({
      kind: 'callback',
      provider: 'fake',
      state: 'state-reconnect',
      code: callback.searchParams.get('code'),
      codeVerifier: verifier,
    }),
  );
  expect(reconnected).toMatchObject({
    status: 200,
    body: { kind: 'connection', status: 'active', scope: 'drive.read' },
  });
  expect(await read('alice')).toEqual({
    status: 200,
    body: { kind: 'connections', connections: [{ ...publicConnection, scope: 'drive.read' }] },
  });
  expect(await read('bob')).toEqual({
    status: 200,
    body: { kind: 'connections', connections: [] },
  });
  const bobConnection = { ...publicConnection, scope: 'calendar.read' };
  await store.credentials.save({ ...bobConnection, subject: 'bob', tokenRef: 'bob-private-ref' });
  expect(await read('bob')).toEqual({
    status: 200,
    body: { kind: 'connections', connections: [bobConnection] },
  });
  expect(await read('alice')).toEqual({
    status: 200,
    body: { kind: 'connections', connections: [{ ...publicConnection, scope: 'drive.read' }] },
  });
  appendResult({ id: 'oauth.blocked-auth', status: 'passed' });
});

function outbox(eventId: string, taskId: string): OutboxEvent {
  return {
    destination: 'work',
    event: {
      eventId,
      eventType: 'task',
      schemaVersion: '1',
      occurredAt: '2026-10-10T10:00:00.000Z',
      taskId,
      stepId: 'transition',
      traceId: 'trace',
      initiatorSubject: 'alice',
      agentPrincipal: 'agent:postgres',
      tool: null,
      policyDecisionId: null,
      approvalId: null,
      requestDigestSha256: null,
      outcome: 'SUCCESS',
      externalObjectRef: null,
      prevDigest: null,
    },
  };
}

function oauthRequest(body: unknown) {
  return {
    method: 'POST',
    path: '/v1/oauth/connections/fake',
    headers: {},
    body: Buffer.from(JSON.stringify(body)),
  };
}

function readConnections(databaseSql: ReturnType<typeof openSql>, now: () => Date) {
  const verify = createIapVerifier({
    jwksUrl: 'https://iap.test/jwks',
    issuer: 'https://iap.test',
    audience: 'oauth-api',
    now: () => at.getTime(),
    fetch: () =>
      Promise.resolve(
        Response.json({ keys: [{ ...keys.publicKey.export({ format: 'jwk' }), kid: 'test' }] }),
      ),
  });
  const route = createOAuthConnectionsReadRoute({
    read: createPostgresOAuthConnectionsReader(databaseSql),
    verify,
    now,
  });
  return async (subject?: string) => {
    const assertion = subject === undefined ? undefined : signedCaller(subject);
    const response = await route({
      method: 'GET',
      path: '/v1/oauth/connections',
      headers: assertion === undefined ? {} : { 'x-goog-iap-jwt-assertion': assertion },
      body: Buffer.alloc(0),
    });
    if (response.status === 200) {
      expect(published.safeParse(response.body).success).toBe(true);
      expect(oauthApiSchema.safeParse(response.body).success).toBe(true);
      expect(JSON.stringify(response.body)).not.toContain(canary);
      expect(JSON.stringify(response.body)).not.toContain('tokenRef');
      expect(JSON.stringify(response.body)).not.toContain(verifier);
    }
    return response;
  };
}

function signedCaller(subject: string): string {
  const header = Buffer.from(JSON.stringify({ alg: 'ES256', kid: 'test' })).toString('base64url');
  const claims = Buffer.from(
    JSON.stringify({
      iss: 'https://iap.test',
      aud: 'oauth-api',
      sub: subject,
      iat: at.getTime() / 1000,
      exp: at.getTime() / 1000 + 3600,
    }),
  ).toString('base64url');
  const input = `${header}.${claims}`;
  return `${input}.${sign('sha256', Buffer.from(input), { key: keys.privateKey, dsaEncoding: 'ieee-p1363' }).toString('base64url')}`;
}
