import { generateKeyPairSync, sign } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import {
  googleIapConfig,
  googleIapIssuer,
  googleIapJwksUrl,
  toIapVerifierOptions,
} from './google-jwks.js';
import { Unavailable, createIapVerifier } from './iap.js';

import type { KeyObject } from 'node:crypto';

const validProjectNumber = '123456789012';
const validRegion = 'asia-northeast1';
const validServiceName = 'agent-works-api';
const frozenNow = 1_700_000_000_000;

describe('googleIapConfig input validation', () => {
  it('exports canonical constants', () => {
    expect(googleIapJwksUrl).toBe('https://www.gstatic.com/iap/verify/public_key-jwk');
    expect(googleIapIssuer).toBe('https://cloud.google.com/iap');
  });

  it('builds valid direct-IAP Cloud Run config with expected audience shape', () => {
    const config = googleIapConfig({
      projectNumber: validProjectNumber,
      region: validRegion,
      serviceName: validServiceName,
    });
    expect(config).toEqual({
      jwksUrl: 'https://www.gstatic.com/iap/verify/public_key-jwk',
      issuer: 'https://cloud.google.com/iap',
      audience: `/projects/${validProjectNumber}/locations/${validRegion}/services/${validServiceName}`,
    });
  });

  it('rejects invalid projectNumber (non-digits, empty, spaces)', () => {
    expect(() =>
      googleIapConfig({ projectNumber: 'abc', region: validRegion, serviceName: validServiceName }),
    ).toThrow(/projectNumber/);
    expect(() =>
      googleIapConfig({ projectNumber: '', region: validRegion, serviceName: validServiceName }),
    ).toThrow(/projectNumber/);
    expect(() =>
      googleIapConfig({
        projectNumber: '12 34',
        region: validRegion,
        serviceName: validServiceName,
      }),
    ).toThrow(/projectNumber/);
    expect(() =>
      googleIapConfig({
        projectNumber: '-1234',
        region: validRegion,
        serviceName: validServiceName,
      }),
    ).toThrow(/projectNumber/);
  });

  it('rejects invalid region (must be asia-northeast1 per ADR 0003)', () => {
    expect(() =>
      googleIapConfig({
        projectNumber: validProjectNumber,
        region: 'us-central1',
        serviceName: validServiceName,
      }),
    ).toThrow(/region.*asia-northeast1/);
    expect(() =>
      googleIapConfig({
        projectNumber: validProjectNumber,
        region: '',
        serviceName: validServiceName,
      }),
    ).toThrow(/region.*asia-northeast1/);
  });

  it('rejects invalid serviceName (bad characters, uppercase, starting with hyphen/digits, trailing hyphen)', () => {
    expect(() =>
      googleIapConfig({
        projectNumber: validProjectNumber,
        region: validRegion,
        serviceName: 'Agent-Works-Api',
      }),
    ).toThrow(/serviceName/);
    expect(() =>
      googleIapConfig({
        projectNumber: validProjectNumber,
        region: validRegion,
        serviceName: '-invalid',
      }),
    ).toThrow(/serviceName/);
    expect(() =>
      googleIapConfig({
        projectNumber: validProjectNumber,
        region: validRegion,
        serviceName: 'invalid-',
      }),
    ).toThrow(/serviceName/);
    expect(() =>
      googleIapConfig({
        projectNumber: validProjectNumber,
        region: validRegion,
        serviceName: '',
      }),
    ).toThrow(/serviceName/);
  });

  it('toIapVerifierOptions helper yields compatible options with overrides', () => {
    const config = googleIapConfig({
      projectNumber: validProjectNumber,
      region: validRegion,
      serviceName: validServiceName,
    });
    const fakeFetch: typeof fetch = () => Promise.reject(new Error('offline'));
    const fakeNow = () => frozenNow;
    const options = toIapVerifierOptions(config, { fetch: fakeFetch, now: fakeNow });
    expect(options).toEqual({
      jwksUrl: config.jwksUrl,
      issuer: config.issuer,
      audience: config.audience,
      fetch: fakeFetch,
      now: fakeNow,
    });
  });
});

describe('end-to-end IAP verifier with Google config', () => {
  const activeKey = keypair('google-key-1');
  const decoyKey = keypair('google-decoy-key');

  const baseConfig = googleIapConfig({
    projectNumber: validProjectNumber,
    region: validRegion,
    serviceName: validServiceName,
  });

  it('accepts valid JWT with Google issuer and direct-IAP Cloud Run audience', async () => {
    const verify = createIapVerifier(
      toIapVerifierOptions(baseConfig, {
        now: () => frozenNow,
        fetch: mockFetchWithKeys([activeKey.jwk]),
      }),
    );
    const token = signedAssertion(activeKey.privateKey, activeKey.jwk.kid, frozenNow, {
      ...googleClaims(baseConfig, frozenNow),
      sub: 'accounts.google.com:10001',
    });
    await expect(verify(token)).resolves.toEqual({
      sub: 'accounts.google.com:10001',
      assertion: token,
      email: 'alice@example.com',
    });
  });

  it('rejects assertion with bad audience', async () => {
    const verify = createIapVerifier(
      toIapVerifierOptions(baseConfig, {
        now: () => frozenNow,
        fetch: mockFetchWithKeys([activeKey.jwk]),
      }),
    );
    const wrongAudience = signedAssertion(activeKey.privateKey, activeKey.jwk.kid, frozenNow, {
      ...googleClaims(baseConfig, frozenNow),
      aud: '/projects/999999999999/locations/asia-northeast1/services/other-service',
    });
    await expect(verify(wrongAudience)).rejects.toMatchObject({
      name: 'Unauthenticated',
      reason: 'bad_claims',
    });
  });

  it('rejects assertion with bad issuer', async () => {
    const verify = createIapVerifier(
      toIapVerifierOptions(baseConfig, {
        now: () => frozenNow,
        fetch: mockFetchWithKeys([activeKey.jwk]),
      }),
    );
    const wrongIssuer = signedAssertion(activeKey.privateKey, activeKey.jwk.kid, frozenNow, {
      ...googleClaims(baseConfig, frozenNow),
      iss: 'https://accounts.google.com',
    });
    await expect(verify(wrongIssuer)).rejects.toMatchObject({
      name: 'Unauthenticated',
      reason: 'bad_claims',
    });
  });

  it('rejects missing or empty assertion', async () => {
    const verify = createIapVerifier(
      toIapVerifierOptions(baseConfig, {
        now: () => frozenNow,
        fetch: mockFetchWithKeys([activeKey.jwk]),
      }),
    );
    await expect(verify(undefined)).rejects.toMatchObject({
      name: 'Unauthenticated',
      reason: 'missing',
    });
    await expect(verify('')).rejects.toMatchObject({
      name: 'Unauthenticated',
      reason: 'missing',
    });
  });

  it('rejects forged assertion (signed with decoy key)', async () => {
    const verify = createIapVerifier(
      toIapVerifierOptions(baseConfig, {
        now: () => frozenNow,
        fetch: mockFetchWithKeys([activeKey.jwk]),
      }),
    );
    const forged = signedAssertion(decoyKey.privateKey, activeKey.jwk.kid, frozenNow, {
      ...googleClaims(baseConfig, frozenNow),
      sub: 'accounts.google.com:10001',
    });
    await expect(verify(forged)).rejects.toMatchObject({
      name: 'Unauthenticated',
      reason: 'bad_signature',
    });
  });

  it('rejects expired assertion', async () => {
    const verify = createIapVerifier(
      toIapVerifierOptions(baseConfig, {
        now: () => frozenNow,
        fetch: mockFetchWithKeys([activeKey.jwk]),
      }),
    );
    const nowSec = Math.floor(frozenNow / 1000);
    const expiredToken = signedAssertion(activeKey.privateKey, activeKey.jwk.kid, frozenNow, {
      ...googleClaims(baseConfig, frozenNow),
      iat: nowSec - 3600,
      exp: nowSec - 100,
    });
    await expect(verify(expiredToken)).rejects.toMatchObject({
      name: 'Unauthenticated',
      reason: 'expired',
    });
  });

  it('handles key rotation when a new kid appears after the 5 s refetch window', async () => {
    const initialKey = keypair('google-key-initial');
    const rotatedKey = keypair('google-key-rotated');

    let currentKeys = [initialKey.jwk];
    let now = frozenNow;

    const verify = createIapVerifier(
      toIapVerifierOptions(baseConfig, {
        now: () => now,
        fetch: () => Promise.resolve(Response.json({ keys: currentKeys })),
      }),
    );

    // Initial key succeeds
    const initialToken = signedAssertion(initialKey.privateKey, initialKey.jwk.kid, now, {
      ...googleClaims(baseConfig, now),
      sub: 'user-initial',
    });
    await expect(verify(initialToken)).resolves.toMatchObject({ sub: 'user-initial' });

    // Rotate keys published by Google
    currentKeys = [rotatedKey.jwk];

    // Rotated token presented before refetch window (5_000 ms) elapses:
    // cache is still considered fresh, so cache won't refresh yet and fails with unknown_key
    const rotatedToken = signedAssertion(rotatedKey.privateKey, rotatedKey.jwk.kid, now, {
      ...googleClaims(baseConfig, now),
      sub: 'user-rotated',
    });
    now += 4_000;
    await expect(verify(rotatedToken)).rejects.toMatchObject({
      name: 'Unauthenticated',
      reason: 'unknown_key',
    });

    // Advance clock past the 5 s refetch window: cache refetches and accepts rotated token
    now += 2_000;
    await expect(verify(rotatedToken)).resolves.toMatchObject({ sub: 'user-rotated' });

    // Note: Stale membership (revocation of a user from Google Workspace / IAM group)
    // is NOT this layer's job. This layer only verifies the cryptographic IAP JWT assertion.
    // Group mapping and role resolution (and their freshness/revocation window) are handled
    // downstream by directory.ts / role-resolver.
  });

  it('JWKS outage fails closed with Unavailable', async () => {
    let networkUp = true;
    const verify = createIapVerifier(
      toIapVerifierOptions(baseConfig, {
        now: () => frozenNow,
        fetch: () => {
          if (!networkUp) {
            return Promise.reject(new Error('network connection refused'));
          }
          return Promise.resolve(Response.json({ keys: [activeKey.jwk] }));
        },
      }),
    );

    networkUp = false;
    const token = signedAssertion(activeKey.privateKey, activeKey.jwk.kid, frozenNow, {
      ...googleClaims(baseConfig, frozenNow),
      sub: 'accounts.google.com:10001',
    });

    await expect(verify(token)).rejects.toBeInstanceOf(Unavailable);
  });

  it('correctly parses realistic Google-shaped JWKS with 5 EC P-256 keys and extra fields', async () => {
    // Realistic Google IAP JWKS observed on 2026-10-15:
    // 5 keys, kty: EC, crv: P-256, alg: ES256, use: sig, plus kid, x, y.
    const keyPairs = Array.from({ length: 5 }, (_, idx) => keypair(`google-kid-${idx + 1}`));
    const realisticGoogleJwks = {
      keys: keyPairs.map((pair) => ({
        kty: 'EC',
        crv: 'P-256',
        alg: 'ES256',
        use: 'sig',
        kid: pair.jwk.kid,
        x: pair.jwk.x,
        y: pair.jwk.y,
      })),
    };

    const verify = createIapVerifier(
      toIapVerifierOptions(baseConfig, {
        now: () => frozenNow,
        fetch: () => Promise.resolve(Response.json(realisticGoogleJwks)),
      }),
    );

    // Any of the 5 keys can be used to sign and verify
    for (const pair of keyPairs) {
      const token = signedAssertion(pair.privateKey, pair.jwk.kid, frozenNow, {
        ...googleClaims(baseConfig, frozenNow),
        sub: `user-for-${pair.jwk.kid}`,
      });
      await expect(verify(token)).resolves.toMatchObject({
        sub: `user-for-${pair.jwk.kid}`,
      });
    }
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
    throw new Error('invalid test ec key');
  }
  return {
    privateKey,
    jwk: { kty: exported.kty, crv: exported.crv, x: exported.x, y: exported.y, kid },
  };
}

function signedAssertion(
  key: KeyObject,
  kid: string,
  nowMs: number,
  claims: Readonly<Record<string, string | number>>,
): string {
  const head = Buffer.from(JSON.stringify({ alg: 'ES256', kid })).toString('base64url');
  const body = Buffer.from(JSON.stringify(claims)).toString('base64url');
  const input = `${head}.${body}`;
  const signature = sign('sha256', Buffer.from(input), { key, dsaEncoding: 'ieee-p1363' }).toString(
    'base64url',
  );
  return `${input}.${signature}`;
}

function googleClaims(
  config: { issuer: string; audience: string },
  nowMs: number,
): {
  readonly iss: string;
  readonly aud: string;
  readonly sub: string;
  readonly iat: number;
  readonly exp: number;
  readonly email: string;
} {
  const nowSec = Math.floor(nowMs / 1000);
  return {
    iss: config.issuer,
    aud: config.audience,
    sub: 'accounts.google.com:10001',
    iat: nowSec,
    exp: nowSec + 3600,
    email: 'alice@example.com',
  };
}

function mockFetchWithKeys(
  keys: readonly { kty: string; crv: string; x: string; y: string; kid: string }[],
): typeof fetch {
  return () => Promise.resolve(Response.json({ keys }));
}
