import { createPublicKey, verify } from 'node:crypto';

import type { JsonWebKey, KeyObject } from 'node:crypto';

type Brand<T, B extends string> = T & { readonly __brand: B };

export type Caller = Brand<{ readonly sub: string; readonly assertion: string }, 'VerifiedCaller'>;

const missing = 'missing';
const malformed = 'malformed';
const unknownKey = 'unknown_key';
const badSignature = 'bad_signature';
const badClaims = 'bad_claims';
const expired = 'expired';

export type UnauthenticatedReason =
  | typeof missing
  | typeof malformed
  | typeof unknownKey
  | typeof badSignature
  | typeof badClaims
  | typeof expired;

export class Unauthenticated extends Error {
  constructor(readonly reason: UnauthenticatedReason) {
    super(`unauthenticated: ${reason}`);
    this.name = 'Unauthenticated';
  }
}

export class Unavailable extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'Unavailable';
  }
}

export type VerifyAssertion = (assertion: string | undefined) => Promise<Caller>;

export type IapVerifierOptions = {
  readonly jwksUrl: string;
  readonly issuer: string;
  readonly audience: string;
  readonly now?: () => number;
  readonly fetch?: typeof fetch;
};

const skewSeconds = 30;
const refetchMs = 5_000;

export function createIapVerifier(options: IapVerifierOptions): VerifyAssertion {
  const cache = createKeyCache(options);
  return (assertion) => verifyToken(options, cache, assertion);
}

function mint(sub: string, assertion: string): Caller {
  return { sub, assertion } as Caller;
}

type KeyCache = {
  keyFor(kid: string): Promise<KeyObject>;
};

function createKeyCache(options: IapVerifierOptions): KeyCache {
  const keys = new Map<string, KeyObject>();
  let fetchedAt = 0;
  const load = options.fetch ?? fetch;
  const clock = options.now ?? Date.now;
  return {
    async keyFor(kid) {
      const now = clock();
      const fresh = fetchedAt !== 0 && now - fetchedAt < refetchMs;
      if (!fresh) {
        await refreshKeys(options.jwksUrl, load, keys);
        fetchedAt = now;
      }
      const found = keys.get(kid);
      if (found === undefined) throw new Unauthenticated(unknownKey);
      return found;
    },
  };
}

async function refreshKeys(
  url: string,
  load: typeof fetch,
  keys: Map<string, KeyObject>,
): Promise<void> {
  let response: Response;
  try {
    response = await load(url);
  } catch (error) {
    throw new Unavailable('jwks fetch failed', { cause: error });
  }
  if (!response.ok) throw new Unavailable('jwks status');
  let body: unknown;
  try {
    body = (await response.json()) as unknown;
  } catch (error) {
    throw new Unavailable('jwks body', { cause: error });
  }
  const next = parseJwks(body);
  keys.clear();
  for (const [kid, key] of next) keys.set(kid, key);
}

function parseJwks(body: unknown): Map<string, KeyObject> {
  if (!isRecord(body) || !Array.isArray(body.keys)) throw new Unavailable('jwks shape');
  const keys = new Map<string, KeyObject>();
  for (const entry of body.keys) {
    const parsed = readJwk(entry);
    if (parsed === undefined) continue;
    try {
      keys.set(parsed.kid, createPublicKey({ key: parsed.jwk, format: 'jwk' }));
    } catch (error) {
      throw new Unavailable('jwks key', { cause: error });
    }
  }
  if (keys.size === 0) throw new Unavailable('jwks keys');
  return keys;
}

function readJwk(value: unknown): { readonly jwk: JsonWebKey; readonly kid: string } | undefined {
  if (!isRecord(value)) return undefined;
  if (value.kty !== 'EC' || value.crv !== 'P-256') return undefined;
  if (typeof value.x !== 'string' || typeof value.y !== 'string' || typeof value.kid !== 'string') {
    return undefined;
  }
  const kid = value.kid;
  return { jwk: { kty: 'EC', crv: 'P-256', x: value.x, y: value.y, kid }, kid };
}

type Token = {
  kid: string;
  signingInput: string;
  claimsPart: string;
  signature: string;
};

async function verifyToken(
  options: IapVerifierOptions,
  cache: KeyCache,
  assertion: string | undefined,
): Promise<Caller> {
  if (assertion === undefined || assertion.length === 0) throw new Unauthenticated(missing);
  const token = parseToken(assertion);
  const key = await cache.keyFor(token.kid);
  const signed = verify(
    'sha256',
    Buffer.from(token.signingInput),
    { key, dsaEncoding: 'ieee-p1363' },
    Buffer.from(token.signature, 'base64url'),
  );
  if (!signed) throw new Unauthenticated(badSignature);
  const claims = readClaims(token.claimsPart);
  assertClaims(claims, options, (options.now ?? Date.now)());
  return mint(claims.sub, assertion);
}

function parseToken(assertion: string | undefined): Token {
  if (assertion === undefined || assertion.length === 0) throw new Unauthenticated(missing);
  const parts = assertion.split('.');
  if (parts.length !== 3) throw new Unauthenticated(malformed);
  const encodedHeader = parts[0];
  const encodedClaims = parts[1];
  const signature = parts[2];
  if (encodedHeader.length === 0 || encodedClaims.length === 0 || signature.length === 0) {
    throw new Unauthenticated(malformed);
  }
  const header = decodePart(encodedHeader);
  if (header === undefined || header.alg !== 'ES256' || typeof header.kid !== 'string') {
    throw new Unauthenticated(malformed);
  }
  if (header.kid.length === 0) throw new Unauthenticated(malformed);
  return {
    kid: header.kid,
    signingInput: `${encodedHeader}.${encodedClaims}`,
    claimsPart: encodedClaims,
    signature,
  };
}

type Claims = {
  iss: string;
  aud: string | readonly string[];
  sub: string;
  exp: number;
  iat: number;
};

function readClaims(part: string): Claims {
  const value = decodePart(part);
  if (value === undefined) throw new Unauthenticated(malformed);
  const aud = readAudience(value.aud);
  if (
    typeof value.iss !== 'string' ||
    typeof value.sub !== 'string' ||
    aud === undefined ||
    typeof value.exp !== 'number' ||
    typeof value.iat !== 'number'
  ) {
    throw new Unauthenticated(badClaims);
  }
  return { iss: value.iss, aud, sub: value.sub, exp: value.exp, iat: value.iat };
}

function assertClaims(claims: Claims, options: IapVerifierOptions, nowMs: number): void {
  if (claims.iss !== options.issuer || claims.sub.length === 0)
    throw new Unauthenticated(badClaims);
  if (!audienceMatches(claims.aud, options.audience)) throw new Unauthenticated(badClaims);
  const nowSec = nowMs / 1000;
  if (claims.exp <= nowSec - skewSeconds) throw new Unauthenticated(expired);
  if (claims.iat > nowSec + skewSeconds) throw new Unauthenticated(badClaims);
}

function audienceMatches(aud: string | readonly string[], expected: string): boolean {
  return typeof aud === 'string' ? aud === expected : aud.includes(expected);
}

function readAudience(value: unknown): string | readonly string[] | undefined {
  if (typeof value === 'string') return value;
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) return undefined;
  return value.filter((item): item is string => typeof item === 'string');
}

function decodePart(part: string): Record<string, unknown> | undefined {
  try {
    const parsed: unknown = JSON.parse(Buffer.from(part, 'base64url').toString('utf8'));
    return isRecord(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
