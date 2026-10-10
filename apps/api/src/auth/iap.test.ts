import { generateKeyPairSync, sign } from 'node:crypto';

import { listen } from '@agent-works/fakes';
import { afterEach, describe, expect, it } from 'vitest';

import { Unavailable, createIapVerifier } from './iap.js';

import type { KeyObject } from 'node:crypto';

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

  it('rejects a cached kid after it leaves the jwks and the refresh window passes', async () => {
    const active = keypair('active');
    const rotated = keypair('rotated');
    const published = { keys: [active.jwk] };
    let now = 1_700_000_000_000;
    const jwks = await listen(() => ({ status: 200, body: { keys: published.keys } }), 0);
    closers.push(jwks.close);
    const verify = createIapVerifier({
      jwksUrl: `${jwks.url}/jwks`,
      issuer,
      audience,
      now: () => now,
    });
    const assertion = signedAssertion(active.privateKey, active.jwk.kid, now);
    await expect(verify(assertion)).resolves.toMatchObject({ sub: 'alice' });

    published.keys = [rotated.jwk];
    now += 4_999;
    await expect(verify(assertion)).resolves.toMatchObject({ sub: 'alice' });

    now += 1;
    await expect(verify(assertion)).rejects.toMatchObject({
      name: 'Unauthenticated',
      reason: 'unknown_key',
    });
  });
});

function keypair(kid: string): {
  readonly privateKey: KeyObject;
  readonly jwk: { kty: string; crv: string; x: string; y: string; kid: string };
} {
  const { publicKey, privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const exported = publicKey.export({ format: 'jwk' });
  if (
    exported.kty !== 'EC' ||
    exported.crv !== 'P-256' ||
    typeof exported.x !== 'string' ||
    typeof exported.y !== 'string'
  ) {
    throw new Error('jwk');
  }
  return {
    privateKey,
    jwk: { kty: exported.kty, crv: exported.crv, x: exported.x, y: exported.y, kid },
  };
}

function signedAssertion(key: KeyObject, kid: string, nowMs: number): string {
  const nowSec = Math.floor(nowMs / 1000);
  const head = Buffer.from(JSON.stringify({ alg: 'ES256', kid })).toString('base64url');
  const body = Buffer.from(
    JSON.stringify({ iss: issuer, aud: audience, sub: 'alice', iat: nowSec, exp: nowSec + 3600 }),
  ).toString('base64url');
  const input = `${head}.${body}`;
  const signature = sign('sha256', Buffer.from(input), { key, dsaEncoding: 'ieee-p1363' }).toString(
    'base64url',
  );
  return `${input}.${signature}`;
}

function token(kid: string): string {
  const head = Buffer.from(JSON.stringify({ alg: 'ES256', kid })).toString('base64url');
  const body = Buffer.from(
    JSON.stringify({ iss: issuer, aud: audience, sub: 'alice', iat: 1, exp: 4_102_444_800 }),
  ).toString('base64url');
  return `${head}.${body}.sig`;
}
