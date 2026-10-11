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
    const provider = createHttpOAuthProvider('https://oauth.example');
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
