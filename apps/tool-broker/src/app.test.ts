import { describe, expect, it } from 'vitest';

import { handleBrokerRequest } from './app.js';
import { createMemoryStore } from './store.js';

import type { BrokerDeps } from './app.js';
import type { GoogleClient } from './google.js';

const accessToken = 'ya29.access-canary';
const refreshToken = '1//refresh-canary';
const secret = 'client-secret-canary';

function idToken(claims: Record<string, unknown>): string {
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
  return `${encode({ alg: 'RS256' })}.${encode(claims)}.signature`;
}

const goodClaims = {
  sub: 'g-1',
  email: 'alice@dr-ubie.com',
  email_verified: true,
  hd: 'dr-ubie.com',
};

type Route = { status: number; body: unknown };
type GoogleCall = { readonly url: string; readonly body: string };

function googleFetch(routes: { token?: Route; revoke?: Route }) {
  const calls: GoogleCall[] = [];
  const fetch = (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = input instanceof URL ? input.href : typeof input === 'string' ? input : input.url;
    const rawBody = init?.body;
    const body =
      rawBody instanceof URLSearchParams
        ? rawBody.toString()
        : typeof rawBody === 'string'
          ? rawBody
          : '';
    calls.push({ url, body });
    const route = url.includes('/revoke') ? routes.revoke : routes.token;
    const reply = route ?? { status: 200, body: {} };
    const payload = typeof reply.body === 'string' ? reply.body : JSON.stringify(reply.body);
    return Promise.resolve(new Response(payload, { status: reply.status }));
  };
  return { fetch, calls };
}

const tokenOk = (claims = goodClaims): Route => ({
  status: 200,
  body: {
    access_token: accessToken,
    refresh_token: refreshToken,
    expires_in: 3600,
    scope: 'openid email https://www.googleapis.com/auth/drive.readonly',
    id_token: idToken(claims),
  },
});

function makeDeps(mock: ReturnType<typeof googleFetch>) {
  const store = createMemoryStore();
  let sequence = 0;
  const google: GoogleClient = { clientId: 'client-id', clientSecret: secret, fetch: mock.fetch };
  const deps: BrokerDeps = {
    store,
    google,
    allowedDomain: 'dr-ubie.com',
    newTokenRef: () => `grant-${++sequence}`,
    now: () => new Date('2026-11-05T00:00:00.000Z'),
  };
  return { deps, store };
}

const exchangeBody = JSON.stringify({
  provider: 'google',
  code: 'auth-code',
  codeVerifier: 'verifier',
  redirectUri: 'http://localhost:8080/oauth/callback',
  subject: 'alice',
});

describe('POST /oauth/token', () => {
  it('exchanges the code and returns metadata only', async () => {
    const mock = googleFetch({ token: tokenOk() });
    const { deps, store } = makeDeps(mock);
    const reply = await handleBrokerRequest(deps, {
      method: 'POST',
      path: '/oauth/token',
      body: exchangeBody,
    });
    expect(reply.status).toBe(200);
    expect(reply.body).toEqual({
      provider: 'google',
      subject: 'alice',
      scope: 'openid email https://www.googleapis.com/auth/drive.readonly',
      status: 'active',
      expiresAt: '2026-11-05T01:00:00.000Z',
      tokenRef: 'grant-1',
    });
    const serialized = JSON.stringify(reply.body);
    expect(serialized).not.toContain(accessToken);
    expect(serialized).not.toContain(refreshToken);
    expect(store.get('grant-1')?.googleSubject).toBe('g-1');
  });

  it('sends the redirect URI, PKCE verifier and client secret to Google', async () => {
    const mock = googleFetch({ token: tokenOk() });
    const { deps } = makeDeps(mock);
    await handleBrokerRequest(deps, { method: 'POST', path: '/oauth/token', body: exchangeBody });
    expect(mock.calls[0]?.url).toBe('https://oauth2.googleapis.com/token');
    const form = new URLSearchParams(mock.calls[0]?.body);
    expect(form.get('redirect_uri')).toBe('http://localhost:8080/oauth/callback');
    expect(form.get('code_verifier')).toBe('verifier');
    expect(form.get('client_secret')).toBe(secret);
    expect(form.get('grant_type')).toBe('authorization_code');
  });

  it('denies an account outside the allowed domain and revokes the new token', async () => {
    const mock = googleFetch({
      token: tokenOk({ ...goodClaims, hd: 'example.com' }),
      revoke: { status: 200, body: {} },
    });
    const { deps, store } = makeDeps(mock);
    const reply = await handleBrokerRequest(deps, {
      method: 'POST',
      path: '/oauth/token',
      body: exchangeBody,
    });
    expect(reply).toEqual({ status: 403, body: { error: 'domain_denied' } });
    expect(store.get('grant-1')).toBeUndefined();
    expect(mock.calls.some((call) => call.url.includes('/revoke'))).toBe(true);
  });

  it('rejects an unverified email without storing anything', async () => {
    const mock = googleFetch({
      token: tokenOk({ ...goodClaims, email_verified: false }),
    });
    const { deps, store } = makeDeps(mock);
    const reply = await handleBrokerRequest(deps, {
      method: 'POST',
      path: '/oauth/token',
      body: exchangeBody,
    });
    expect(reply).toEqual({ status: 403, body: { error: 'identity_rejected' } });
    expect(store.get('grant-1')).toBeUndefined();
  });

  it('reports a Google refusal without echoing Google response text', async () => {
    const mock = googleFetch({
      token: { status: 400, body: `invalid_grant echo ${secret}` },
    });
    const { deps } = makeDeps(mock);
    const reply = await handleBrokerRequest(deps, {
      method: 'POST',
      path: '/oauth/token',
      body: exchangeBody,
    });
    expect(reply).toEqual({ status: 502, body: { error: 'provider_rejected' } });
    expect(JSON.stringify(reply.body)).not.toContain(secret);
  });

  it.each([
    ['missing subject', { ...JSON.parse(exchangeBody), subject: undefined }],
    ['wrong provider', { ...JSON.parse(exchangeBody), provider: 'github' }],
    ['missing code', { ...JSON.parse(exchangeBody), code: '' }],
  ])('rejects a bad body: %s', async (_name, body) => {
    const { deps } = makeDeps(googleFetch({}));
    const reply = await handleBrokerRequest(deps, {
      method: 'POST',
      path: '/oauth/token',
      body: JSON.stringify(body),
    });
    expect(reply).toEqual({ status: 400, body: { error: 'bad_request' } });
  });

  it('rejects a body that is not JSON', async () => {
    const { deps } = makeDeps(googleFetch({}));
    const reply = await handleBrokerRequest(deps, {
      method: 'POST',
      path: '/oauth/token',
      body: 'not json',
    });
    expect(reply.status).toBe(400);
  });
});

describe('GET /oauth/tokens/{ref}', () => {
  it('returns metadata for a stored grant and never a token', async () => {
    const { deps } = makeDeps(googleFetch({ token: tokenOk() }));
    await handleBrokerRequest(deps, { method: 'POST', path: '/oauth/token', body: exchangeBody });
    const reply = await handleBrokerRequest(deps, {
      method: 'GET',
      path: '/oauth/tokens/grant-1',
      body: '',
    });
    expect(reply.status).toBe(200);
    expect(JSON.stringify(reply.body)).not.toContain(accessToken);
  });

  it('returns 404 for an unknown reference', async () => {
    const { deps } = makeDeps(googleFetch({}));
    const reply = await handleBrokerRequest(deps, {
      method: 'GET',
      path: '/oauth/tokens/missing',
      body: '',
    });
    expect(reply).toEqual({ status: 404, body: { error: 'not_found' } });
  });
});

describe('POST /oauth/revoke', () => {
  it('revokes the refresh token at Google and marks the grant revoked', async () => {
    const mock = googleFetch({ token: tokenOk(), revoke: { status: 200, body: {} } });
    const { deps, store } = makeDeps(mock);
    await handleBrokerRequest(deps, { method: 'POST', path: '/oauth/token', body: exchangeBody });
    const reply = await handleBrokerRequest(deps, {
      method: 'POST',
      path: '/oauth/revoke',
      body: JSON.stringify({ tokenRef: 'grant-1' }),
    });
    expect(reply.status).toBe(200);
    expect(reply.body).toMatchObject({ status: 'revoked', tokenRef: 'grant-1' });
    expect(store.get('grant-1')?.status).toBe('revoked');
    const revokeCall = mock.calls.find((call) => call.url.includes('/revoke'));
    expect(revokeCall?.body).toContain(encodeURIComponent(refreshToken));
  });

  it('keeps the grant active when Google refuses the revocation', async () => {
    const mock = googleFetch({
      token: tokenOk(),
      revoke: { status: 400, body: 'invalid_token' },
    });
    const { deps, store } = makeDeps(mock);
    await handleBrokerRequest(deps, { method: 'POST', path: '/oauth/token', body: exchangeBody });
    const reply = await handleBrokerRequest(deps, {
      method: 'POST',
      path: '/oauth/revoke',
      body: JSON.stringify({ tokenRef: 'grant-1' }),
    });
    expect(reply).toEqual({ status: 502, body: { error: 'revoke_failed' } });
    expect(store.get('grant-1')?.status).toBe('active');
  });

  it('returns 404 for an unknown grant', async () => {
    const { deps } = makeDeps(googleFetch({}));
    const reply = await handleBrokerRequest(deps, {
      method: 'POST',
      path: '/oauth/revoke',
      body: JSON.stringify({ tokenRef: 'missing' }),
    });
    expect(reply.status).toBe(404);
  });
});

describe('routing', () => {
  it('returns 404 for an unknown route', async () => {
    const { deps } = makeDeps(googleFetch({}));
    const reply = await handleBrokerRequest(deps, { method: 'GET', path: '/nope', body: '' });
    expect(reply.status).toBe(404);
  });
});
