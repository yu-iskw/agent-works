import { createHash } from 'node:crypto';

import { oauthCallbackSchema, oauthConnectionSchema, oauthStartSchema } from '@agent-works/domain';

import type { Handler, Reply } from './http.js';
import type { OAuthCallback, OAuthConnection } from '@agent-works/domain';

const activeUntil = '2099-01-01T00:00:00.000Z';
const expiredAt = '2020-01-01T00:00:00.000Z';
const canary = 'canary-do-not-log';

type Code = {
  provider: string;
  state: string;
  codeChallenge: string;
  subject: string;
  scope: string;
};

type TokenStatus = OAuthConnection['status'];

type Issued = {
  secret: string;
  tokenRef: string;
  provider: string;
  subject: string;
  scope: string;
  status: TokenStatus;
  expiresAt: string;
};

export function createOAuth(): Handler {
  const codes = new Map<string, Code>();
  const tokens = new Map<string, Issued>();
  const sequence = { code: 0, token: 0 };
  return (request) => {
    if (request.method === 'POST' && request.url.pathname === '/oauth/authorize') {
      return authorize(codes, sequence, request.body);
    }
    if (request.method === 'POST' && request.url.pathname === '/oauth/token') {
      return exchange(codes, tokens, sequence, request.body);
    }
    if (request.method === 'POST' && request.url.pathname === '/oauth/revoke') {
      return setStatus(tokens, request.body, 'revoked');
    }
    if (request.method === 'POST' && request.url.pathname === '/oauth/expire') {
      return setStatus(tokens, request.body, 'expired');
    }
    const match = /^\/oauth\/tokens\/([^/]+)$/.exec(request.url.pathname);
    if (request.method === 'GET' && match !== null) return readToken(tokens, match[1]);
    return { status: 404, body: { error: 'not found' } };
  };
}

function authorize(
  codes: Map<string, Code>,
  sequence: { code: number; token: number },
  body: Buffer,
): Reply {
  const parsed = readAuthorize(body);
  if (parsed === undefined) return { status: 400, body: { error: 'bad body' } };
  sequence.code += 1;
  const code = `code-${sequence.code}`;
  codes.set(code, parsed);
  return { status: 200, body: { code, state: parsed.state } };
}

function exchange(
  codes: Map<string, Code>,
  tokens: Map<string, Issued>,
  sequence: { code: number; token: number },
  body: Buffer,
): Reply {
  const parsed = readExchange(body);
  if (parsed === undefined) return { status: 400, body: { error: 'bad body' } };
  const code = codes.get(parsed.code);
  if (code === undefined) return { status: 400, body: { error: 'bad code' } };
  if (code.provider !== parsed.provider)
    return { status: 400, body: { error: 'provider_mismatch' } };
  if (code.state !== parsed.state) return { status: 400, body: { error: 'state_mismatch' } };
  if (code.codeChallenge !== s256(parsed.codeVerifier)) {
    return { status: 400, body: { error: 'pkce_mismatch' } };
  }
  codes.delete(parsed.code);
  sequence.token += 1;
  const issued = issue(sequence.token, code);
  tokens.set(issued.tokenRef, issued);
  return { status: 200, body: { ...view(issued), token: issued.secret } };
}

function setStatus(tokens: Map<string, Issued>, body: Buffer, status: TokenStatus): Reply {
  const tokenRef = readTokenRef(body);
  if (tokenRef === undefined) return { status: 400, body: { error: 'bad body' } };
  const issued = tokens.get(tokenRef);
  if (issued === undefined) return { status: 404, body: { error: 'not found' } };
  const next: Issued = {
    ...issued,
    status,
    expiresAt: status === 'expired' ? expiredAt : issued.expiresAt,
  };
  tokens.set(tokenRef, next);
  return { status: 200, body: view(next) };
}

function readToken(tokens: Map<string, Issued>, tokenRef: string | undefined): Reply {
  if (tokenRef === undefined) return { status: 404, body: { error: 'not found' } };
  const issued = tokens.get(tokenRef);
  if (issued === undefined) return { status: 404, body: { error: 'not found' } };
  return { status: 200, body: view(issued) };
}

function issue(sequence: number, code: Code): Issued {
  return {
    secret: canary,
    tokenRef: `token-${sequence}`,
    provider: code.provider,
    subject: code.subject,
    scope: code.scope,
    status: 'active',
    expiresAt: activeUntil,
  };
}

function view(issued: Issued): OAuthConnection {
  return oauthConnectionSchema.parse({
    provider: issued.provider,
    subject: issued.subject,
    scope: issued.scope,
    status: issued.status,
    expiresAt: issued.expiresAt,
    tokenRef: issued.tokenRef,
  });
}

function s256(verifier: string): string {
  return createHash('sha256').update(verifier).digest('base64url');
}

function readAuthorize(body: Buffer): Code | undefined {
  const parsed = readJson(body);
  if (parsed === undefined) return undefined;
  const subject = text(parsed, 'subject');
  if (subject === undefined) return undefined;
  const start = oauthStartSchema.safeParse({
    provider: parsed.provider,
    state: parsed.state,
    codeChallenge: parsed.codeChallenge,
    codeChallengeMethod: parsed.codeChallengeMethod,
    scope: parsed.scope,
  });
  if (!start.success) return undefined;
  return {
    subject,
    provider: start.data.provider,
    state: start.data.state,
    codeChallenge: start.data.codeChallenge,
    scope: start.data.scope,
  };
}

function readExchange(body: Buffer): OAuthCallback | undefined {
  const parsed = readJson(body);
  if (parsed === undefined) return undefined;
  const callback = oauthCallbackSchema.safeParse(parsed);
  return callback.success ? callback.data : undefined;
}

function readTokenRef(body: Buffer): string | undefined {
  const parsed = readJson(body);
  if (parsed === undefined) return undefined;
  return text(parsed, 'tokenRef');
}

function text(record: Record<string, unknown>, key: string): string | undefined {
  const value = Reflect.get(record, key);
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function readJson(body: Buffer): Record<string, unknown> | undefined {
  try {
    const parsed: unknown = JSON.parse(body.toString('utf8'));
    if (!isRecord(parsed)) return undefined;
    return parsed;
  } catch {
    return undefined;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
