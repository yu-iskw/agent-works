import { listen } from '@agent-works/fakes';
import { afterEach, describe, expect, it } from 'vitest';

import { Unavailable, createIapVerifier } from './iap.js';

const issuer = 'https://fake-iap.local';
const audience = 'agent-works-dev';

describe('IAP verifier', () => {
  const closers: (() => Promise<void>)[] = [];

  afterEach(async () => {
    const open = closers.splice(0);
    for (const close of open) await close();
  });

  it('returns unavailable when a published key is not a public key', async () => {
    const jwks = await listen(
      () => ({
        status: 200,
        body: { keys: [{ kty: 'EC', crv: 'P-256', x: 'AAAA', y: 'AAAA', kid: 'k' }] },
      }),
      0,
    );
    closers.push(jwks.close);
    const verify = createIapVerifier({ jwksUrl: `${jwks.url}/jwks`, issuer, audience });
    await expect(verify(token('k'))).rejects.toBeInstanceOf(Unavailable);
  });

  it('returns unavailable when the key set is empty', async () => {
    const jwks = await listen(() => ({ status: 200, body: { keys: [] } }), 0);
    closers.push(jwks.close);
    const verify = createIapVerifier({ jwksUrl: `${jwks.url}/jwks`, issuer, audience });
    await expect(verify(token('k'))).rejects.toBeInstanceOf(Unavailable);
  });
});

function token(kid: string): string {
  const head = Buffer.from(JSON.stringify({ alg: 'ES256', kid })).toString('base64url');
  const body = Buffer.from(
    JSON.stringify({ iss: issuer, aud: audience, sub: 'alice', iat: 1, exp: 4_102_444_800 }),
  ).toString('base64url');
  return `${head}.${body}.sig`;
}
