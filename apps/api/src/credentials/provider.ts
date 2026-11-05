import { oauthConnectionSchema } from '@agent-works/domain';

import { OAuthDenied, oauthFailure } from './denied.js';

import type { OAuthCallback, OAuthConnection, OAuthStart } from '@agent-works/domain';

export interface OAuthProvider {
  authorizationUrl(subject: string, start: OAuthStart): string;
  exchange(callback: OAuthCallback, subject: string): Promise<OAuthConnection>;
  read(tokenRef: string): Promise<OAuthConnection>;
  revoke(tokenRef: string): Promise<OAuthConnection>;
}

/** Production sign-in: the browser goes straight to Google and the broker holds the client secret. */
export type GoogleSignIn = {
  readonly clientId: string;
  readonly hostedDomain: string;
};

type Reply = { readonly status: number; readonly body: unknown };

const googleAuthorizeUrl = 'https://accounts.google.com/o/oauth2/v2/auth';

/**
 * Without `google`, the provider speaks the fake broker contract used by local and e2e stacks.
 * With `google`, it speaks the aw-tool-broker contract: the broker exchanges the code and returns
 * connection metadata only, so no token is expected in the response.
 */
export function createHttpOAuthProvider(
  baseUrl: string,
  redirectUri: string,
  authorizationBaseUrl = baseUrl,
  google?: GoogleSignIn,
): OAuthProvider {
  return {
    authorizationUrl(subject, start) {
      if (google !== undefined) return googleAuthorizationUrl(google, redirectUri, start);
      const url = new URL('/oauth/authorize', authorizationBaseUrl);
      url.search = new URLSearchParams({
        response_type: 'code',
        subject,
        redirect_uri: redirectUri,
        provider: start.provider,
        state: start.state,
        code_challenge: start.codeChallenge,
        code_challenge_method: start.codeChallengeMethod,
        scope: start.scope,
      }).toString();
      return url.toString();
    },
    exchange(callback, subject) {
      if (google === undefined) return post(baseUrl, '/oauth/token', callback).then(issued);
      return post(baseUrl, '/oauth/token', {
        provider: callback.provider,
        code: callback.code,
        codeVerifier: callback.codeVerifier,
        redirectUri,
        subject,
      }).then(connectionOnly);
    },
    read(tokenRef) {
      return get(baseUrl, `/oauth/tokens/${encodeURIComponent(tokenRef)}`).then(connectionOnly);
    },
    revoke(tokenRef) {
      return post(baseUrl, '/oauth/revoke', { tokenRef }).then(connectionOnly);
    },
  };
}

function googleAuthorizationUrl(google: GoogleSignIn, redirectUri: string, start: OAuthStart) {
  const url = new URL(googleAuthorizeUrl);
  url.search = new URLSearchParams({
    client_id: google.clientId,
    redirect_uri: redirectUri,
    response_type: 'code',
    scope: ['openid', 'email', start.scope].join(' '),
    state: start.state,
    code_challenge: start.codeChallenge,
    code_challenge_method: start.codeChallengeMethod,
    access_type: 'offline',
    prompt: 'consent',
    hd: google.hostedDomain,
  }).toString();
  return url.toString();
}

function issued(reply: Reply): OAuthConnection {
  const connection = connectionOnly(reply);
  if (!isRecord(reply.body) || !hasSecret(reply.body)) {
    throw new OAuthDenied(oauthFailure.rejected);
  }
  return connection;
}

function connectionOnly(reply: Reply): OAuthConnection {
  if (reply.status !== 200 || !isRecord(reply.body)) {
    throw new OAuthDenied(oauthFailure.rejected);
  }
  const parsed = oauthConnectionSchema.safeParse({
    provider: reply.body.provider,
    subject: reply.body.subject,
    scope: reply.body.scope,
    status: reply.body.status,
    expiresAt: reply.body.expiresAt,
    tokenRef: reply.body.tokenRef,
  });
  if (!parsed.success) throw new OAuthDenied(oauthFailure.rejected);
  return parsed.data;
}

function hasSecret(body: Record<string, unknown>): boolean {
  const secret = body.token;
  return typeof secret === 'string' && secret.length > 0;
}

async function post(baseUrl: string, path: string, body: unknown): Promise<Reply> {
  const response = await fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return readReply(response);
}

async function get(baseUrl: string, path: string): Promise<Reply> {
  const response = await fetch(`${baseUrl}${path}`);
  return readReply(response);
}

async function readReply(response: Response): Promise<Reply> {
  try {
    const body: unknown = await response.json();
    return { status: response.status, body };
  } catch {
    return { status: response.status, body: undefined };
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
