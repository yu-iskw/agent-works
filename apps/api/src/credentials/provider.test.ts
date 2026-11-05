import { afterEach, expect, it, vi } from 'vitest';

import { createHttpOAuthProvider } from './provider.js';

afterEach(() => {
  vi.unstubAllGlobals();
});

it.each(['exchange', 'revoke'] as const)(
  '%s posts JSON with its content type',
  async (operation) => {
    const connection = {
      provider: 'fake',
      subject: 'alice',
      scope: 'ticket.create',
      status: 'active',
      expiresAt: '2099-01-01T00:00:00.000Z',
      tokenRef: 'token-1',
    };
    const fetchMock = vi.fn().mockResolvedValue(Response.json({ ...connection, token: 'secret' }));
    vi.stubGlobal('fetch', fetchMock);
    const provider = createHttpOAuthProvider(
      'https://oauth.example',
      'https://app.example/oauth/callback',
    );
    const callback = {
      provider: 'fake',
      state: 'state-1',
      code: 'code-1',
      codeVerifier: 'verifier',
    };
    const result =
      operation === 'exchange'
        ? await provider.exchange(callback, 'alice')
        : await provider.revoke(connection.tokenRef);
    expect(result).toEqual(connection);
    expect(fetchMock).toHaveBeenCalledExactlyOnceWith(
      `https://oauth.example/oauth/${operation === 'exchange' ? 'token' : 'revoke'}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(
          operation === 'exchange' ? callback : { tokenRef: connection.tokenRef },
        ),
      },
    );
  },
);

it('builds a provider consent URL with state and PKCE', () => {
  const provider = createHttpOAuthProvider(
    'https://oauth.example',
    'https://app.example/oauth/callback',
  );
  const url = new URL(
    provider.authorizationUrl('alice & bob', {
      provider: 'fake',
      state: 'state & value',
      codeChallenge: 'challenge',
      codeChallengeMethod: 'S256',
      scope: 'ticket.create',
    }),
  );
  expect(url.origin + url.pathname).toBe('https://oauth.example/oauth/authorize');
  expect(Object.fromEntries(url.searchParams)).toEqual({
    response_type: 'code',
    subject: 'alice & bob',
    redirect_uri: 'https://app.example/oauth/callback',
    provider: 'fake',
    state: 'state & value',
    code_challenge: 'challenge',
    code_challenge_method: 'S256',
    scope: 'ticket.create',
  });
});

const googleSignIn = {
  clientId: '123-client.apps.googleusercontent.com',
  hostedDomain: 'dr-ubie.com',
};

it('sends the browser to Google with offline access and the hosted-domain hint', () => {
  const provider = createHttpOAuthProvider(
    'https://broker.internal',
    'http://localhost:8080/oauth/callback',
    undefined,
    googleSignIn,
  );
  const url = new URL(
    provider.authorizationUrl('alice', {
      provider: 'google',
      state: 'state-1',
      codeChallenge: 'challenge',
      codeChallengeMethod: 'S256',
      scope: 'https://www.googleapis.com/auth/drive.readonly',
    }),
  );
  expect(url.origin + url.pathname).toBe('https://accounts.google.com/o/oauth2/v2/auth');
  expect(Object.fromEntries(url.searchParams)).toEqual({
    client_id: '123-client.apps.googleusercontent.com',
    redirect_uri: 'http://localhost:8080/oauth/callback',
    response_type: 'code',
    scope: 'openid email https://www.googleapis.com/auth/drive.readonly',
    state: 'state-1',
    code_challenge: 'challenge',
    code_challenge_method: 'S256',
    access_type: 'offline',
    prompt: 'consent',
    hd: 'dr-ubie.com',
  });
});

it('asks the broker to exchange the code and accepts metadata without a token', async () => {
  const connection = {
    provider: 'google',
    subject: 'alice',
    scope: 'openid email',
    status: 'active',
    expiresAt: '2099-01-01T00:00:00.000Z',
    tokenRef: 'grant-1',
  };
  const fetchMock = vi.fn().mockResolvedValue(Response.json(connection));
  vi.stubGlobal('fetch', fetchMock);
  const provider = createHttpOAuthProvider(
    'https://broker.internal',
    'http://localhost:8080/oauth/callback',
    undefined,
    googleSignIn,
  );
  const result = await provider.exchange(
    { provider: 'google', state: 'state-1', code: 'code-1', codeVerifier: 'verifier' },
    'alice',
  );
  expect(result).toEqual(connection);
  expect(fetchMock).toHaveBeenCalledExactlyOnceWith('https://broker.internal/oauth/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      provider: 'google',
      code: 'code-1',
      codeVerifier: 'verifier',
      redirectUri: 'http://localhost:8080/oauth/callback',
      subject: 'alice',
    }),
  });
});

it('rejects a broker refusal in Google mode', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn().mockResolvedValue(Response.json({ error: 'domain_denied' }, { status: 403 })),
  );
  const provider = createHttpOAuthProvider(
    'https://broker.internal',
    'http://localhost:8080/oauth/callback',
    undefined,
    googleSignIn,
  );
  await expect(
    provider.exchange(
      { provider: 'google', state: 'state-1', code: 'code-1', codeVerifier: 'verifier' },
      'alice',
    ),
  ).rejects.toThrow();
});
