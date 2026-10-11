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
        ? await provider.exchange(callback)
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
