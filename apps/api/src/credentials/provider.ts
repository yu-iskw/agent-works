import { oauthConnectionSchema } from '@agent-works/domain';

import { OAuthDenied, oauthFailure } from './denied.js';

import type { OAuthCallback, OAuthConnection } from '@agent-works/domain';

export interface OAuthProvider {
  exchange(callback: OAuthCallback): Promise<OAuthConnection>;
  read(tokenRef: string): Promise<OAuthConnection>;
  revoke(tokenRef: string): Promise<OAuthConnection>;
}

type Reply = { readonly status: number; readonly body: unknown };

export function createHttpOAuthProvider(baseUrl: string): OAuthProvider {
  return {
    exchange(callback) {
      return post(baseUrl, '/oauth/token', callback).then(issued);
    },
    read(tokenRef) {
      return get(baseUrl, `/oauth/tokens/${encodeURIComponent(tokenRef)}`).then(connectionOnly);
    },
    revoke(tokenRef) {
      return post(baseUrl, '/oauth/revoke', { tokenRef }).then(connectionOnly);
    },
  };
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
