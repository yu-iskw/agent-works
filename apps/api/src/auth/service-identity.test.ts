import { describe, expect, it } from 'vitest';

import { AuthorizationDenied, Unauthenticated } from './iap.js';
import {
  createServiceIdentityPolicy,
  googleServiceIssuers,
  verifyServiceClaims,
} from './service-identity.js';

const audience = 'https://aw-worker-abc123-an.a.run.app';
const dispatcher = 'aw-dispatcher@aw-dev.iam.gserviceaccount.com';
const now = 1_800_000_000_000;
const nowSec = now / 1000;

const policy = createServiceIdentityPolicy({ audience, authorizedEmails: [dispatcher] });

function claims(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    iss: 'https://accounts.google.com',
    aud: audience,
    sub: '123456789012345678901',
    email: dispatcher,
    email_verified: true,
    iat: nowSec - 10,
    exp: nowSec + 3000,
    ...overrides,
  };
}

function reasonOf(run: () => unknown): string {
  try {
    run();
  } catch (error) {
    if (error instanceof Unauthenticated) return error.reason;
    if (error instanceof AuthorizationDenied) return 'denied';
    throw error;
  }
  return 'accepted';
}

describe('verifyServiceClaims', () => {
  it('accepts the authorized worker caller with the exact audience', () => {
    expect(verifyServiceClaims(claims(), policy, now)).toEqual({
      email: dispatcher,
      sub: '123456789012345678901',
    });
  });

  it('accepts both Google issuer spellings', () => {
    for (const iss of googleServiceIssuers) {
      expect(reasonOf(() => verifyServiceClaims(claims({ iss }), policy, now))).toBe('accepted');
    }
  });

  it.each([
    ['IAP human assertion issuer', { iss: 'https://cloud.google.com/iap' }],
    ['foreign issuer', { iss: 'https://evil.example' }],
    ['missing issuer', { iss: undefined }],
    ['wrong audience', { aud: 'https://aw-api-abc123-an.a.run.app' }],
    ['IAP-style audience', { aud: '/projects/1/locations/asia-northeast1/services/aw-web' }],
    ['audience list with extra entry', { aud: [audience, 'https://other.example'] }],
    ['missing audience', { aud: undefined }],
    ['expired token', { exp: nowSec - 31 }],
    ['future iat', { iat: nowSec + 600 }],
    ['missing expiry', { exp: undefined }],
    ['empty subject', { sub: '' }],
    ['unverified email', { email_verified: false }],
    ['missing email', { email: undefined }],
  ])('rejects %s as unauthenticated', (_name, overrides) => {
    expect(reasonOf(() => verifyServiceClaims(claims(overrides), policy, now))).not.toBe(
      'accepted',
    );
    expect(() => verifyServiceClaims(claims(overrides), policy, now)).toThrow(Unauthenticated);
  });

  it('reports expiry distinctly from other bad claims', () => {
    expect(reasonOf(() => verifyServiceClaims(claims({ exp: nowSec - 31 }), policy, now))).toBe(
      'expired',
    );
  });

  it('tolerates the clock skew window at expiry', () => {
    expect(reasonOf(() => verifyServiceClaims(claims({ exp: nowSec - 29 }), policy, now))).toBe(
      'accepted',
    );
  });

  it.each([
    ['the human API service account', 'aw-api@aw-dev.iam.gserviceaccount.com'],
    ['the worker itself', 'aw-worker@aw-dev.iam.gserviceaccount.com'],
    ['a different project principal', 'aw-dispatcher@other.iam.gserviceaccount.com'],
    ['a case-varied email', 'AW-Dispatcher@aw-dev.iam.gserviceaccount.com'],
    ['a human user email', 'alice@example.com'],
  ])('denies a valid token from %s', (_name, email) => {
    expect(() => verifyServiceClaims(claims({ email }), policy, now)).toThrow(AuthorizationDenied);
  });
});

describe('createServiceIdentityPolicy', () => {
  it('refuses an empty allowlist so no token can pass by default', () => {
    expect(() => createServiceIdentityPolicy({ audience, authorizedEmails: [] })).toThrow(
      /must not be empty/,
    );
  });

  it('refuses a non service account principal', () => {
    expect(() =>
      createServiceIdentityPolicy({ audience, authorizedEmails: ['alice@example.com'] }),
    ).toThrow(/invalid service account email/);
  });

  it('refuses a non https or malformed audience', () => {
    expect(() =>
      createServiceIdentityPolicy({ audience: 'http://worker', authorizedEmails: [dispatcher] }),
    ).toThrow(/invalid audience/);
    expect(() =>
      createServiceIdentityPolicy({ audience: '', authorizedEmails: [dispatcher] }),
    ).toThrow(/invalid audience/);
  });
});
