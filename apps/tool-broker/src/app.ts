import { exchangeCode, GoogleRejected, revokeGoogleToken } from './google.js';

import type { GoogleClient } from './google.js';
import type { GrantStore, StoredGrant } from './store.js';

/**
 * Internal contract for the API. Cloud Run IAM admits only the API service account, so the
 * broker does not authenticate callers itself. Responses carry connection metadata only and never a token.
 *
 * POST /oauth/token   { provider, code, codeVerifier, redirectUri, subject }
 * GET  /oauth/tokens/{tokenRef}
 * POST /oauth/revoke  { tokenRef }
 */
export type BrokerDeps = {
  readonly store: GrantStore;
  readonly google: GoogleClient;
  /** Google accounts must belong to this hosted domain, for example company.example. */
  readonly allowedDomain: string;
  readonly newTokenRef: () => string;
  readonly now: () => Date;
};

export type BrokerRequest = {
  readonly method: string;
  readonly path: string;
  readonly body: string;
};

export type BrokerReply = {
  readonly status: number;
  readonly body: Record<string, unknown>;
};

type ConnectionView = {
  readonly provider: 'google';
  readonly subject: string;
  readonly scope: string;
  readonly status: StoredGrant['status'];
  readonly expiresAt: string;
  readonly tokenRef: string;
};

export async function handleBrokerRequest(
  deps: BrokerDeps,
  request: BrokerRequest,
): Promise<BrokerReply> {
  if (request.method === 'POST' && request.path === '/oauth/token') {
    return exchange(deps, request.body);
  }
  if (request.method === 'POST' && request.path === '/oauth/revoke') {
    return revoke(deps, request.body);
  }
  const match = /^\/oauth\/tokens\/([^/]+)$/.exec(request.path);
  if (request.method === 'GET' && match !== null) {
    const grant = deps.store.get(decodeURIComponent(match[1]));
    return grant === undefined ? notFound() : { status: 200, body: view(grant) };
  }
  return notFound();
}

async function exchange(deps: BrokerDeps, raw: string): Promise<BrokerReply> {
  const input = readObject(raw);
  const provider = input?.provider;
  const code = text(input, 'code');
  const codeVerifier = text(input, 'codeVerifier');
  const redirectUri = text(input, 'redirectUri');
  const subject = text(input, 'subject');
  if (
    provider !== 'google' ||
    code === undefined ||
    codeVerifier === undefined ||
    redirectUri === undefined ||
    subject === undefined
  ) {
    return badRequest();
  }
  let grant;
  try {
    grant = await exchangeCode(deps.google, { code, codeVerifier, redirectUri });
  } catch (error) {
    if (error instanceof GoogleRejected && error.reason === 'token_exchange') {
      return { status: 502, body: { error: 'provider_rejected' } };
    }
    if (error instanceof GoogleRejected)
      return { status: 403, body: { error: 'identity_rejected' } };
    throw error;
  }
  if (grant.identity.hostedDomain !== deps.allowedDomain) {
    await revokeQuietly(deps, grant.refreshToken ?? grant.accessToken);
    return { status: 403, body: { error: 'domain_denied' } };
  }
  const stored: StoredGrant = {
    tokenRef: deps.newTokenRef(),
    provider: 'google',
    subject,
    scope: grant.scope,
    googleSubject: grant.identity.sub,
    googleEmail: grant.identity.email,
    status: 'active',
    expiresAt: new Date(deps.now().getTime() + grant.expiresInSeconds * 1000).toISOString(),
    accessToken: grant.accessToken,
    refreshToken: grant.refreshToken,
  };
  deps.store.save(stored);
  return { status: 200, body: view(stored) };
}

async function revoke(deps: BrokerDeps, raw: string): Promise<BrokerReply> {
  const tokenRef = text(readObject(raw), 'tokenRef');
  if (tokenRef === undefined) return badRequest();
  const grant = deps.store.get(tokenRef);
  if (grant === undefined) return notFound();
  try {
    await revokeGoogleToken(deps.google, grant.refreshToken ?? grant.accessToken);
  } catch (error) {
    if (error instanceof GoogleRejected) return { status: 502, body: { error: 'revoke_failed' } };
    throw error;
  }
  const next = deps.store.setStatus(tokenRef, 'revoked');
  return next === undefined ? notFound() : { status: 200, body: view(next) };
}

async function revokeQuietly(deps: BrokerDeps, token: string): Promise<void> {
  try {
    await revokeGoogleToken(deps.google, token);
  } catch {
    // The grant is already rejected. Google's failure reason is not surfaced to the caller.
  }
}

function view(grant: StoredGrant): ConnectionView {
  return {
    provider: grant.provider,
    subject: grant.subject,
    scope: grant.scope,
    status: grant.status,
    expiresAt: grant.expiresAt,
    tokenRef: grant.tokenRef,
  };
}

function readObject(raw: string): Record<string, unknown> | undefined {
  try {
    const parsed: unknown = JSON.parse(raw);
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

function text(record: Record<string, unknown> | undefined, key: string): string | undefined {
  const value = record === undefined ? undefined : Reflect.get(record, key);
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function badRequest(): BrokerReply {
  return { status: 400, body: { error: 'bad_request' } };
}

function notFound(): BrokerReply {
  return { status: 404, body: { error: 'not_found' } };
}
