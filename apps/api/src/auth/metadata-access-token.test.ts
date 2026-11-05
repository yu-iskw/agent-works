import { describe, expect, it } from 'vitest';

import { createMetadataAccessToken } from './metadata-access-token.js';

function tokenResponse(token: string, expiresIn: number): Response {
  return new Response(JSON.stringify({ access_token: token, expires_in: expiresIn }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

describe('createMetadataAccessToken', () => {
  it('reads the service account token from the metadata server with the Google flavor header', async () => {
    const calls: { url: string; flavor: string | null }[] = [];
    const token = createMetadataAccessToken({
      fetch: (url, init) => {
        calls.push({
          url: new Request(url).url,
          flavor: new Headers(init?.headers).get('metadata-flavor'),
        });
        return Promise.resolve(tokenResponse('tok-1', 3600));
      },
      now: () => 0,
    });
    await expect(token()).resolves.toBe('tok-1');
    expect(calls).toEqual([
      {
        url: 'http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token',
        flavor: 'Google',
      },
    ]);
  });

  it('reuses a cached token until it is close to expiry, then refreshes', async () => {
    let clock = 0;
    let issued = 0;
    const token = createMetadataAccessToken({
      fetch: () => {
        issued += 1;
        return Promise.resolve(tokenResponse(`tok-${issued}`, 3600));
      },
      now: () => clock,
    });
    await expect(token()).resolves.toBe('tok-1');
    clock = 1_000;
    await expect(token()).resolves.toBe('tok-1');
    clock = 3_600_000 - 30_000;
    await expect(token()).resolves.toBe('tok-2');
    expect(issued).toBe(2);
  });

  it('rejects when the metadata server refuses or returns a malformed body', async () => {
    const refused = createMetadataAccessToken({
      fetch: () => Promise.resolve(new Response('denied', { status: 403 })),
    });
    await expect(refused()).rejects.toThrow('metadata access token unavailable');

    const malformed = createMetadataAccessToken({
      fetch: () => Promise.resolve(new Response('{}', { status: 200 })),
    });
    await expect(malformed()).rejects.toThrow('metadata access token malformed');
  });
});
