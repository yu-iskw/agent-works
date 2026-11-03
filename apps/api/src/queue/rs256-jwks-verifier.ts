import { createPublicKey, verify } from 'node:crypto';

import { Unauthenticated, Unavailable } from '../auth/iap.js';

import type { KeyObject } from 'node:crypto';

const googleOauthCertsUrl = 'https://www.googleapis.com/oauth2/v3/certs';

/** Verifies the signature of a compact JWT and returns its claims. Claim policy is checked by the caller. */
export type VerifyIdToken = (token: string) => Promise<Readonly<Record<string, unknown>>>;

export type Rs256JwksVerifierOptions = {
  readonly jwksUrl?: string;
  readonly fetch?: typeof fetch;
  readonly now?: () => number;
};

const refetchMs = 5_000;

export function createRs256JwksVerifier(options: Rs256JwksVerifierOptions = {}): VerifyIdToken {
  const url = options.jwksUrl ?? googleOauthCertsUrl;
  const load = options.fetch ?? fetch;
  const clock = options.now ?? Date.now;
  let keys = new Map<string, KeyObject>();
  let fetchedAt = 0;

  async function keyFor(kid: string): Promise<KeyObject> {
    const known = keys.get(kid);
    if (known !== undefined) return known;
    const now = clock();
    if (fetchedAt === 0 || now - fetchedAt >= refetchMs) {
      keys = await fetchKeys(url, load);
      fetchedAt = now;
    }
    const found = keys.get(kid);
    if (found === undefined) throw new Unauthenticated('unknown_key');
    return found;
  }

  return async (token) => {
    const parsed = parseToken(token);
    const key = await keyFor(parsed.kid);
    const signed = verify('sha256', Buffer.from(parsed.signingInput), key, parsed.signature);
    if (!signed) throw new Unauthenticated('bad_signature');
    return parsed.claims;
  };
}

function parseToken(token: string): {
  readonly kid: string;
  readonly signingInput: string;
  readonly signature: Buffer;
  readonly claims: Record<string, unknown>;
} {
  const parts = token.split('.');
  const [encodedHeader, encodedClaims, signature] = parts;
  if (parts.length !== 3 || parts.some((part) => part.length === 0)) {
    throw new Unauthenticated('malformed');
  }
  const header = decodePart(encodedHeader);
  const claims = decodePart(encodedClaims);
  if (header?.alg !== 'RS256' || typeof header.kid !== 'string' || header.kid.length === 0) {
    throw new Unauthenticated('malformed');
  }
  if (claims === undefined) throw new Unauthenticated('malformed');
  return {
    kid: header.kid,
    signingInput: `${encodedHeader}.${encodedClaims}`,
    signature: Buffer.from(signature, 'base64url'),
    claims,
  };
}

async function fetchKeys(url: string, load: typeof fetch): Promise<Map<string, KeyObject>> {
  let body: unknown;
  try {
    const response = await load(url);
    if (!response.ok) throw new Unavailable('jwks status');
    body = (await response.json()) as unknown;
  } catch (error) {
    throw error instanceof Unavailable ? error : new Unavailable('jwks fetch', { cause: error });
  }
  if (!isRecord(body) || !Array.isArray(body.keys)) throw new Unavailable('jwks shape');
  const keys = new Map<string, KeyObject>();
  for (const entry of body.keys as unknown[]) {
    const parsed = parseRsaKey(entry);
    if (parsed !== undefined) keys.set(parsed.kid, parsed.key);
  }
  if (keys.size === 0) throw new Unavailable('jwks keys');
  return keys;
}

function parseRsaKey(entry: unknown): { kid: string; key: KeyObject } | undefined {
  if (!isRecord(entry) || entry.kty !== 'RSA') return undefined;
  const { kid, n, e, use } = entry;
  if (typeof kid !== 'string' || typeof n !== 'string' || typeof e !== 'string') return undefined;
  if (use !== undefined && use !== 'sig') return undefined;
  try {
    return { kid, key: createPublicKey({ key: { kty: 'RSA', n, e }, format: 'jwk' }) };
  } catch {
    return undefined;
  }
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
