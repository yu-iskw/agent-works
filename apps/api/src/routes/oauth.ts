import { oauthApiSchema } from '@agent-works/domain';

import { OAuthDenied, oauthFailure } from '../credentials/denied.js';

import type { OAuthFlow } from '../credentials/flow.js';
import type { ApiReply, Route } from '../http.js';
import type { OAuthCallback, OAuthConnection, OAuthStart } from '@agent-works/domain';
import type { IncomingHttpHeaders } from 'node:http';

const invalidRequest = { status: 400, body: { error: 'invalid_request' } } as const;
const unauthenticated = { status: 401, body: { error: 'unauthenticated' } } as const;
const notFound = { status: 404, body: { error: 'not_found' } } as const;
const connectionPath = /^\/v1\/oauth\/connections\/([^/]+)$/;

export type OAuthRouteDeps = {
  readonly flow: OAuthFlow;
  readonly subject: (headers: IncomingHttpHeaders) => string | undefined;
};

export function createOAuthConnectRoute(deps: OAuthRouteDeps): Route {
  return async (request) => {
    const subject = caller(deps, request.headers);
    if (subject === undefined) return unauthenticated;
    const provider = pathProvider(request.path);
    if (provider === undefined) return notFound;
    const parsed = oauthApiSchema.safeParse(parseJson(request.body));
    if (!parsed.success) return invalidRequest;
    if (parsed.data.provider !== provider) return invalidRequest;
    switch (parsed.data.kind) {
      case 'start':
        return started(await deps.flow.begin(subject, startOf(parsed.data)));
      case 'callback': {
        const callback = callbackOf(parsed.data);
        return connectionReply(() => deps.flow.complete(subject, callback));
      }
      case 'connection':
        return invalidRequest;
      default: {
        const unexpected: never = parsed.data;
        return unexpected;
      }
    }
  };
}

export function createOAuthRevokeRoute(deps: OAuthRouteDeps): Route {
  return async (request) => {
    const subject = caller(deps, request.headers);
    if (subject === undefined) return unauthenticated;
    const provider = pathProvider(request.path);
    if (provider === undefined) return notFound;
    return connectionReply(() => deps.flow.revoke(subject, provider));
  };
}

function caller(deps: OAuthRouteDeps, headers: IncomingHttpHeaders): string | undefined {
  const subject = deps.subject(headers);
  if (subject === undefined || subject.length === 0) return undefined;
  return subject;
}

function started(start: OAuthStart): ApiReply {
  return { status: 200, body: { kind: 'start', ...start } };
}

async function connectionReply(load: () => Promise<OAuthConnection>): Promise<ApiReply> {
  try {
    const connection = await load();
    return { status: 200, body: { kind: 'connection', ...connection } };
  } catch (error) {
    if (error instanceof OAuthDenied) return denied(error);
    throw error;
  }
}

function denied(error: OAuthDenied): ApiReply {
  if (error.code === oauthFailure.missing) return notFound;
  return { status: 400, body: { error: error.code } };
}

function startOf(data: OAuthStart): OAuthStart {
  return {
    provider: data.provider,
    state: data.state,
    codeChallenge: data.codeChallenge,
    codeChallengeMethod: data.codeChallengeMethod,
    scope: data.scope,
  };
}

function callbackOf(data: OAuthCallback): OAuthCallback {
  return {
    provider: data.provider,
    state: data.state,
    code: data.code,
    codeVerifier: data.codeVerifier,
  };
}

function pathProvider(path: string): string | undefined {
  const match = connectionPath.exec(path);
  return match?.[1];
}

function parseJson(body: Buffer): unknown {
  try {
    return JSON.parse(body.toString('utf8')) as unknown;
  } catch {
    return undefined;
  }
}
