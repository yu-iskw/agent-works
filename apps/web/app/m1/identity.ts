import {
  createHash,
  createPublicKey,
  generateKeyPairSync,
  randomBytes,
  sign,
  timingSafeEqual,
  verify,
} from 'node:crypto';

import { ASSERTION_ISSUERS } from '@agent-works/domain/teamwork';

import { LOCAL_TEST_MEMBERS, segmentsFor } from './config.js';

import type { WebConfig } from './config.js';
import type { WebDb } from './db.js';
import type { JsonWebKey, KeyObject } from 'node:crypto';

export type Session = {
  readonly sub: string;
  readonly email: string;
  readonly name: string;
  readonly idp: 'google' | 'local-test';
  readonly csrf: string;
  readonly expiresAt: Date;
};

export const SESSION_COOKIE = 'aw_m1_session';
const SESSION_TTL_MS = 12 * 60 * 60 * 1000;
const LOGIN_TTL_MS = 10 * 60 * 1000;
const GOOGLE_ISSUERS = new Set(['https://accounts.google.com', 'accounts.google.com']);
const GOOGLE_JWKS = 'https://www.googleapis.com/oauth2/v3/certs';
const LOCAL_TEST = 'local-test';
const E2E_AUDIT = 'e2e.session';

const b64url = (value: Buffer | string) => Buffer.from(value).toString('base64url');
const sha256 = (value: string) => createHash('sha256').update(value).digest('hex');

export class SignInError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = 'SignInError';
  }
}

/** Short-lived ES256 member assertions for the segment APIs; the key never leaves this process. */
export function createAssertionSigner(mode: WebConfig['identity']) {
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const kid = randomBytes(8).toString('hex');
  const jwk = { ...publicKey.export({ format: 'jwk' }), kid, alg: 'ES256', use: 'sig' };
  return {
    jwks: { keys: [jwk] },
    mint(session: Pick<Session, 'sub' | 'email'>, segment: string, nowMs = Date.now()): string {
      const header = b64url(JSON.stringify({ alg: 'ES256', typ: 'JWT', kid }));
      const iat = Math.floor(nowMs / 1000);
      const claims = b64url(
        JSON.stringify({
          // eslint-disable-next-line security/detect-object-injection
          iss: ASSERTION_ISSUERS[mode],
          aud: `segment:${segment}`,
          sub: session.sub,
          email: session.email,
          iat,
          exp: iat + 60,
        }),
      );
      const signature = sign('sha256', Buffer.from(`${header}.${claims}`), {
        key: privateKey,
        dsaEncoding: 'ieee-p1363',
      });
      return `${header}.${claims}.${b64url(signature)}`;
    },
  };
}

export type AssertionSigner = ReturnType<typeof createAssertionSigner>;

type GoogleKey = { kid: string; key: KeyObject };

type GoogleUser = { sub: string; email: string; name: string };

function decodeIdToken(idToken: string): {
  h: string;
  c: string;
  s: string;
  header: { alg: string; kid: string };
  claims: Record<string, unknown>;
} {
  const [h = '', c = '', s = ''] = idToken.split('.');
  let header: { alg?: string; kid?: string };
  let claims: Record<string, unknown>;
  try {
    header = JSON.parse(Buffer.from(h, 'base64url').toString('utf8')) as {
      alg?: string;
      kid?: string;
    };
    claims = JSON.parse(Buffer.from(c, 'base64url').toString('utf8')) as Record<string, unknown>;
  } catch {
    throw new SignInError('malformed_token');
  }
  if (header.alg !== 'RS256' || typeof header.kid !== 'string')
    throw new SignInError('malformed_token');
  return { h, c, s, header: { alg: header.alg, kid: header.kid }, claims };
}

function checkClaims(
  claims: Record<string, unknown>,
  expected: { clientId: string; now: number; nonce: string | null },
): GoogleUser {
  const { clientId, now, nonce } = expected;
  if (typeof claims.iss !== 'string' || !GOOGLE_ISSUERS.has(claims.iss))
    throw new SignInError('bad_issuer');
  if (claims.aud !== clientId) throw new SignInError('bad_audience');
  if (typeof claims.exp !== 'number' || claims.exp < now - 30) throw new SignInError('expired');
  if (typeof claims.iat !== 'number' || claims.iat > now + 60) throw new SignInError('bad_claims');
  if (nonce !== null && claims.nonce !== nonce) throw new SignInError('bad_nonce');
  return verifiedUser(claims);
}

function verifiedUser(claims: Record<string, unknown>): GoogleUser {
  if (
    claims.email_verified !== true ||
    typeof claims.email !== 'string' ||
    typeof claims.sub !== 'string'
  )
    throw new SignInError('email_unverified');
  return {
    sub: claims.sub,
    email: claims.email.toLowerCase(),
    name: typeof claims.name === 'string' ? claims.name : claims.email,
  };
}

/** Verifies a Google ID token: RS256 signature against Google's keys, issuer, audience, expiry, nonce. */
export function createGoogleVerifier(
  clientId: string,
  load: typeof fetch = fetch,
  clock: () => number = Date.now,
) {
  let keys: GoogleKey[] = [];
  let fetchedAt = 0;
  async function keyFor(kid: string): Promise<KeyObject> {
    const stale = clock() - fetchedAt > 60 * 60 * 1000;
    if (stale || !keys.some((k) => k.kid === kid)) {
      const response = await load(GOOGLE_JWKS, { signal: AbortSignal.timeout(10_000) });
      if (!response.ok) throw new SignInError('google_keys_unavailable');
      const body = (await response.json()) as { keys?: (JsonWebKey & { kid?: string })[] };
      keys = (body.keys ?? [])
        .filter((k) => k.kty === 'RSA' && typeof k.kid === 'string')
        .map((k) => ({ kid: k.kid as string, key: createPublicKey({ key: k, format: 'jwk' }) }));
      fetchedAt = clock();
    }
    const found = keys.find((k) => k.kid === kid);
    if (found === undefined) throw new SignInError('unknown_key');
    return found.key;
  }
  return async (idToken: string, nonce: string | null): Promise<GoogleUser> => {
    const { h, c, s, header, claims } = decodeIdToken(idToken);
    const key = await keyFor(header.kid);
    if (!verify('RSA-SHA256', Buffer.from(`${h}.${c}`), key, Buffer.from(s, 'base64url')))
      throw new SignInError('bad_signature');
    return checkClaims(claims, { clientId, now: clock() / 1000, nonce });
  };
}

type GoogleVerifier = ReturnType<typeof createGoogleVerifier>;

export type Identity = ReturnType<typeof createIdentity>;

export function createIdentity(deps: {
  readonly config: WebConfig;
  readonly db: WebDb;
  readonly verifyGoogle: GoogleVerifier | undefined;
  readonly fetch?: typeof fetch;
  readonly now?: () => Date;
}) {
  const { config, db } = deps;
  const load = deps.fetch ?? fetch;
  const now = deps.now ?? (() => new Date());
  const redirectUri = `${config.publicUrl}/auth/google/callback`;

  async function createSession(
    user: { sub: string; email: string; name: string },
    idp: Session['idp'],
  ): Promise<{ cookie: string; session: Session }> {
    if (segmentsFor(config, user.email).length === 0) throw new SignInError('not_a_member');
    const id = randomBytes(32).toString('base64url');
    const csrf = randomBytes(32).toString('hex');
    const expiresAt = new Date(now().getTime() + SESSION_TTL_MS);
    await db.sql`
      insert into m1_sessions (id_sha256, sub, email, name, idp, csrf, created_at, expires_at)
      values (${sha256(id)}, ${user.sub}, ${user.email}, ${user.name}, ${idp}, ${csrf}, ${now()}, ${expiresAt})
    `;
    await db.audit(user.sub, 'session.create', idp);
    return { cookie: id, session: { ...user, idp, csrf, expiresAt } };
  }

  return {
    redirectUri,
    async session(cookieValue: string | undefined): Promise<Session | undefined> {
      if (cookieValue === undefined || !/^[\w-]{20,100}$/.test(cookieValue)) return undefined;
      const rows = await db.sql<
        {
          sub: string;
          email: string;
          name: string;
          idp: Session['idp'];
          csrf: string;
          expires_at: Date;
        }[]
      >`
        select sub, email, name, idp, csrf, expires_at from m1_sessions where id_sha256 = ${sha256(cookieValue)} and expires_at > ${now()}
      `;
      const row = rows.at(0);
      // A session minted under the other identity mode can never be used.
      if (row === undefined || row.idp !== config.identity) return undefined;
      return {
        sub: row.sub,
        email: row.email,
        name: row.name,
        idp: row.idp,
        csrf: row.csrf,
        expiresAt: row.expires_at,
      };
    },
    async signOut(cookieValue: string | undefined): Promise<void> {
      if (cookieValue !== undefined)
        await db.sql`delete from m1_sessions where id_sha256 = ${sha256(cookieValue)}`;
    },
    /** Authorization code flow with state, nonce and PKCE; all three are single-use and expire. */
    async startGoogle(returnTo: string): Promise<string> {
      if (config.google === undefined) throw new SignInError('not_configured');
      const state = randomBytes(24).toString('base64url');
      const nonce = randomBytes(24).toString('base64url');
      const verifier = randomBytes(48).toString('base64url');
      await db.sql`
        insert into m1_login_states (state, nonce, code_verifier, return_to, expires_at)
        values (${state}, ${nonce}, ${verifier}, ${returnTo}, ${new Date(now().getTime() + LOGIN_TTL_MS)})
      `;
      const params = new URLSearchParams({
        client_id: config.google.clientId,
        redirect_uri: redirectUri,
        response_type: 'code',
        scope: 'openid email profile',
        state,
        nonce,
        code_challenge: b64url(createHash('sha256').update(verifier).digest()),
        code_challenge_method: 'S256',
        // Offline access only feeds the e2e re-verification; without e2e mode no refresh token exists.
        access_type: config.e2eSecret === undefined ? 'online' : 'offline',
        prompt: config.e2eSecret === undefined ? 'select_account' : 'consent select_account',
      });
      return `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`;
    },
    async completeGoogle(
      code: string,
      state: string,
    ): Promise<{ cookie: string; session: Session; returnTo: string }> {
      if (config.google === undefined || deps.verifyGoogle === undefined)
        throw new SignInError('not_configured');
      const claimed = await db.sql<{ nonce: string; code_verifier: string; return_to: string }[]>`
        delete from m1_login_states where state = ${state} and expires_at > ${now()} returning nonce, code_verifier, return_to
      `;
      const login = claimed.at(0);
      if (login === undefined) throw new SignInError('bad_state');
      const response = await load('https://oauth2.googleapis.com/token', {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          code,
          client_id: config.google.clientId,
          client_secret: config.google.clientSecret,
          redirect_uri: redirectUri,
          grant_type: 'authorization_code',
          code_verifier: login.code_verifier,
        }),
        signal: AbortSignal.timeout(15_000),
      });
      const body = (await response.json().catch(() => ({}))) as {
        id_token?: string;
        refresh_token?: string;
      };
      if (!response.ok || body.id_token === undefined) throw new SignInError('exchange_failed');
      const user = await deps.verifyGoogle(body.id_token, login.nonce);
      const created = await createSession(user, 'google');
      if (body.refresh_token !== undefined && config.e2eSecret !== undefined)
        await db.storeRefresh(user.email, user.sub, body.refresh_token);
      return { ...created, returnTo: login.return_to };
    },
    async localTest(email: string): Promise<{ cookie: string; session: Session }> {
      if (
        config.identity !== LOCAL_TEST ||
        !(LOCAL_TEST_MEMBERS as readonly string[]).includes(email)
      )
        throw new SignInError('not_available');
      const name = email.split('@')[0] ?? email;
      return createSession(
        { sub: `local-test:${name}`, email, name: `${name} (local test)` },
        LOCAL_TEST,
      );
    },
    /**
     * Re-verifies a real member for browser tests: Google exchanges the member's stored refresh
     * token for a fresh ID token, which is verified exactly like an interactive sign-in. Off unless
     * AW_E2E_MODE=1 and a secret is configured; served only on the internal listener.
     */
    async e2eSession(
      secret: string | undefined,
      email: string,
    ): Promise<{ cookie: string; session: Session }> {
      const expected = config.e2eSecret;
      if (expected === undefined) throw new SignInError('disabled');
      if (
        secret === undefined ||
        Buffer.byteLength(secret) !== Buffer.byteLength(expected) ||
        !timingSafeEqual(Buffer.from(secret), Buffer.from(expected))
      ) {
        await db.audit(null, E2E_AUDIT, 'bad_secret');
        throw new SignInError('forbidden');
      }
      if (config.identity === LOCAL_TEST) return this.localTest(email);
      if (config.google === undefined || deps.verifyGoogle === undefined)
        throw new SignInError('not_configured');
      const refresh = await db.readRefresh(email.toLowerCase());
      if (refresh === undefined) throw new SignInError('reauth_required');
      const response = await load('https://oauth2.googleapis.com/token', {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          client_id: config.google.clientId,
          client_secret: config.google.clientSecret,
          refresh_token: refresh,
          grant_type: 'refresh_token',
        }),
        signal: AbortSignal.timeout(15_000),
      });
      const body = (await response.json().catch(() => ({}))) as { id_token?: string };
      if (!response.ok || body.id_token === undefined) {
        await db.audit(null, E2E_AUDIT, 'reauth_required');
        throw new SignInError('reauth_required');
      }
      const user = await deps.verifyGoogle(body.id_token, null);
      if (user.email !== email.toLowerCase()) throw new SignInError('account_mismatch');
      const created = await createSession(user, 'google');
      await db.audit(user.sub, E2E_AUDIT, 'issued');
      return created;
    },
  };
}
