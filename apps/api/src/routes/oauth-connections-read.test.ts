import { generateKeyPairSync, sign } from 'node:crypto';
import { createServer } from 'node:http';

import { IAP_ASSERTION_HEADER, oauthApiSchema } from '@agent-works/domain';
import { expect, it, vi } from 'vitest';

import { createApp } from '../app.js';
import { createMemoryAuditLog } from '../audit/write.js';
import { Unavailable, createIapVerifier } from '../auth/iap.js';

import { createOAuthConnectionsReadRoute } from './oauth-connections-read.js';
import { createOAuthConnectRoute } from './oauth.js';

import type { OAuthConnectionsReadDeps } from './oauth-connections-read.js';

const now = new Date('2026-10-10T10:00:00.000Z');
const keys = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
const issuer = 'https://iap.test';
const audience = 'oauth-api';
const verify = createIapVerifier({
  jwksUrl: `${issuer}/jwks`,
  issuer,
  audience,
  now: () => now.getTime(),
  fetch: () =>
    Promise.resolve(
      Response.json({ keys: [{ ...keys.publicKey.export({ format: 'jwk' }), kid: 'test' }] }),
    ),
});
const summary = {
  provider: 'fake',
  scope: 'drive.read calendar.read',
  status: 'active' as const,
  expiresAt: '2099-01-01T00:00:00.000Z',
};

function assertion(subject: string, exp = now.getTime() / 1000 + 3600): string {
  const head = Buffer.from(JSON.stringify({ alg: 'ES256', kid: 'test' })).toString('base64url');
  const body = Buffer.from(
    JSON.stringify({
      iss: issuer,
      aud: audience,
      sub: subject,
      iat: now.getTime() / 1000 - 120,
      exp,
    }),
  ).toString('base64url');
  const input = `${head}.${body}`;
  return `${input}.${sign('sha256', Buffer.from(input), { key: keys.privateKey, dsaEncoding: 'ieee-p1363' }).toString('base64url')}`;
}

function request(token?: string) {
  return {
    method: 'GET',
    path: '/v1/oauth/connections',
    headers: {
      ...(token === undefined ? {} : { [IAP_ASSERTION_HEADER]: token }),
      cookie: 'subject=alice',
      'x-user-id': 'alice',
    },
    body: Buffer.from('{"subject":"alice"}'),
  };
}

it('derives isolation solely from verified identity and projects only public metadata', async () => {
  const read = vi.fn((subject: string) =>
    Promise.resolve(
      subject === 'alice'
        ? [
            {
              ...summary,
              subject,
              tokenRef: 'private-ref',
              accessToken: 'secret',
              refreshToken: 'secret',
              codeVerifier: 'secret',
              clientSecret: 'secret',
            },
          ]
        : [],
    ),
  );
  const route = createOAuthConnectionsReadRoute({ verify, read, now: () => now });
  expect(await route(request(assertion('bob')))).toEqual({
    status: 200,
    body: { kind: 'connections', connections: [] },
  });
  const alice = await route(request(assertion('alice')));
  expect(alice).toEqual({ status: 200, body: { kind: 'connections', connections: [summary] } });
  expect(oauthApiSchema.parse(alice.body)).toEqual(alice.body);
  expect(read.mock.calls).toEqual([['bob'], ['alice']]);
});

it.each([undefined, 'forged', assertion('alice', now.getTime() / 1000 - 60), assertion('')])(
  'rejects invalid authentication without reading grants (%#)',
  async (token) => {
    const read = vi.fn(() => Promise.resolve([]));
    const route = createOAuthConnectionsReadRoute({ verify, read, now: () => now });
    expect(await route(request(token))).toEqual({
      status: 401,
      body: { error: 'unauthenticated' },
    });
    expect(read).not.toHaveBeenCalled();
  },
);

it('reports identity service failure without exposing error details', async () => {
  const read = vi.fn(() => Promise.resolve([]));
  const route = createOAuthConnectionsReadRoute({
    verify: () => Promise.reject(new Unavailable('private-detail')),
    read,
    now: () => now,
  });
  expect(await route(request())).toEqual({ status: 503, body: { error: 'unavailable' } });
  expect(read).not.toHaveBeenCalled();
});

it('rejects the list response as a connect request without invoking the OAuth flow', async () => {
  const unused = vi.fn(() => Promise.reject(new Error('unused')));
  const route = createOAuthConnectRoute({
    subject: () => 'alice',
    flow: { begin: unused, complete: unused, revoke: unused, blockIfStale: unused },
  });
  expect(
    await route({
      ...request(),
      method: 'POST',
      path: '/v1/oauth/connections/fake',
      body: Buffer.from(JSON.stringify({ kind: 'connections', connections: [] })),
    }),
  ).toEqual({ status: 400, body: { error: 'invalid_request' } });
  expect(unused).not.toHaveBeenCalled();
});

it('distinguishes absent, revoked, expired and reconnected grants on each read', async () => {
  let connections: Awaited<ReturnType<OAuthConnectionsReadDeps['read']>> = [];
  const route = createOAuthConnectionsReadRoute({
    verify,
    read: () => Promise.resolve(connections),
    now: () => now,
  });
  const call = () => route(request(assertion('alice')));
  expect(await call()).toMatchObject({ body: { connections: [] } });
  connections = [{ ...summary, status: 'revoked', expiresAt: now.toISOString() }];
  expect(await call()).toMatchObject({ body: { connections: [{ status: 'revoked' }] } });
  connections = [{ ...summary, expiresAt: now.toISOString() }];
  expect(await call()).toMatchObject({ body: { connections: [{ status: 'expired' }] } });
  connections = [{ ...summary, status: 'expired' }];
  expect(await call()).toMatchObject({ body: { connections: [{ status: 'expired' }] } });
  connections = [summary];
  expect(await call()).toMatchObject({ body: { connections: [{ status: 'active' }] } });
});

it('registers the authenticated list endpoint through the application', async () => {
  const read = vi.fn((subject: string) => Promise.resolve(subject === 'alice' ? [summary] : []));
  const server = createServer(
    createApp(
      {
        verify,
        oauthConnections: { read, now: () => now },
        drive: { retrieve: () => Promise.resolve([]) },
        runner: { run: () => Promise.reject(new Error('unused')) },
        audit: createMemoryAuditLog(),
        now: () => now,
      },
      {},
    ),
  );
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const address = server.address();
    if (address === null || typeof address === 'string') throw new Error('port');
    const url = `http://127.0.0.1:${address.port}/v1/oauth/connections?subject=alice`;
    const unauthorized = await fetch(url, {
      headers: { cookie: 'subject=alice', 'x-user-id': 'alice' },
    });
    expect(unauthorized.status).toBe(401);
    expect(read).not.toHaveBeenCalled();
    const bob = await fetch(url, { headers: { [IAP_ASSERTION_HEADER]: assertion('bob') } });
    expect(bob.status).toBe(200);
    expect(await bob.json()).toEqual({ kind: 'connections', connections: [] });
    const alice = await fetch(url, { headers: { [IAP_ASSERTION_HEADER]: assertion('alice') } });
    expect(alice.status).toBe(200);
    expect(await alice.json()).toEqual({ kind: 'connections', connections: [summary] });
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
});
