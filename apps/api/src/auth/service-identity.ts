import { AuthorizationDenied, Unauthenticated } from './iap.js';

export const googleServiceIssuers = ['https://accounts.google.com', 'accounts.google.com'] as const;

const serviceAccountEmail = /^[a-z][a-z0-9-]+@[a-z][a-z0-9-]+\.iam\.gserviceaccount\.com$/;
const skewSeconds = 30;

export type ServiceIdentityPolicy = {
  readonly issuers: readonly string[];
  /** Exact audience the caller minted its ID token for: the worker endpoint URL. */
  readonly audience: string;
  readonly authorizedEmails: ReadonlySet<string>;
};

export type ServiceCaller = {
  readonly email: string;
  readonly sub: string;
};

export function createServiceIdentityPolicy(input: {
  readonly audience: string;
  readonly authorizedEmails: readonly string[];
  readonly issuers?: readonly string[];
}): ServiceIdentityPolicy {
  if (!URL.canParse(input.audience) || !input.audience.startsWith('https://')) {
    throw new Error('invalid audience: must be the https URL of the worker endpoint');
  }
  if (input.authorizedEmails.length === 0) throw new Error('authorizedEmails must not be empty');
  for (const email of input.authorizedEmails) {
    if (!serviceAccountEmail.test(email))
      throw new Error(`invalid service account email: ${email}`);
  }
  return {
    issuers: input.issuers ?? googleServiceIssuers,
    audience: input.audience,
    authorizedEmails: new Set(input.authorizedEmails),
  };
}

/**
 * Validates the claim set of an ID token whose signature was already verified
 * against Google's JWKS. Wrong issuer, audience or time bounds are
 * unauthenticated; a valid token from a principal outside the allowlist is denied.
 */
export function verifyServiceClaims(
  claims: Readonly<Record<string, unknown>>,
  policy: ServiceIdentityPolicy,
  nowMs: number,
): ServiceCaller {
  const { iss, aud, sub, email } = claims;
  if (typeof iss !== 'string' || !policy.issuers.includes(iss)) {
    throw new Unauthenticated('bad_claims');
  }
  if (!audienceMatches(aud, policy.audience)) throw new Unauthenticated('bad_claims');
  assertTimeBounds(claims, nowMs);
  if (typeof sub !== 'string' || sub.length === 0) throw new Unauthenticated('bad_claims');
  if (typeof email !== 'string' || claims.email_verified !== true) {
    throw new Unauthenticated('bad_claims');
  }
  if (!policy.authorizedEmails.has(email)) throw new AuthorizationDenied();
  return { email, sub };
}

function assertTimeBounds(claims: Readonly<Record<string, unknown>>, nowMs: number): void {
  const { exp, iat } = claims;
  if (typeof exp !== 'number' || typeof iat !== 'number') throw new Unauthenticated('bad_claims');
  const nowSec = nowMs / 1000;
  if (exp <= nowSec - skewSeconds) throw new Unauthenticated('expired');
  if (iat > nowSec + skewSeconds) throw new Unauthenticated('bad_claims');
}

function audienceMatches(aud: unknown, expected: string): boolean {
  if (typeof aud === 'string') return aud === expected;
  return Array.isArray(aud) && aud.length === 1 && aud[0] === expected;
}
