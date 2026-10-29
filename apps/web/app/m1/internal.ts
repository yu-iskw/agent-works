import { readBody } from '../body.js';

import { SESSION_COOKIE, SignInError } from './identity.js';

import type { WebConfig } from './config.js';
import type { AssertionSigner, Identity } from './identity.js';
import type { IncomingMessage, RequestListener, ServerResponse } from 'node:http';

async function body(request: IncomingMessage): Promise<unknown> {
  const raw = await readBody(request, 4096);
  if (raw === undefined) return undefined;
  try {
    return JSON.parse(raw.toString('utf8')) as unknown;
  } catch {
    return undefined;
  }
}

function e2eSecretOf(request: IncomingMessage): string | undefined {
  const secret = request.headers['x-e2e-secret'];
  return typeof secret === 'string' ? secret : undefined;
}

function reply(response: ServerResponse, status: number, payload: unknown): void {
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  });
  response.end(JSON.stringify(payload));
}

/**
 * The internal listener: the member-assertion JWKS for the segment APIs, and the e2e session
 * endpoints. Compose never publishes this port. The e2e routes fail closed: without
 * AW_E2E_MODE=1 and a configured secret (`config.e2eSecret`) they answer 404 like any unknown path.
 */
export function createInternalHandler(deps: {
  readonly config: Pick<WebConfig, 'e2eSecret' | 'members'>;
  readonly identity: Pick<Identity, 'e2eSession' | 'e2eAuthorize'>;
  readonly signer: Pick<AssertionSigner, 'jwks'>;
}): RequestListener {
  async function e2eSession(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const input = (await body(request)) as { email?: unknown } | undefined;
    try {
      const done = await deps.identity.e2eSession(
        e2eSecretOf(request),
        typeof input?.email === 'string' ? input.email : '',
      );
      return reply(response, 200, {
        cookie: { name: SESSION_COOKIE, value: done.cookie },
        email: done.session.email,
        idp: done.session.idp,
        expiresAt: done.session.expiresAt.toISOString(),
      });
    } catch (error) {
      const code = error instanceof SignInError ? error.code : 'unavailable';
      return reply(response, code === 'forbidden' ? 403 : 409, { error: code });
    }
  }
  /** Configured member emails per segment, in file order, so live suites never read the secrets file. */
  async function e2eMembers(request: IncomingMessage, response: ServerResponse): Promise<void> {
    try {
      await deps.identity.e2eAuthorize(e2eSecretOf(request));
    } catch {
      return reply(response, 403, { error: 'forbidden' });
    }
    return reply(
      response,
      200,
      Object.fromEntries(
        [...deps.config.members].map(([segment, emails]) => [segment, [...emails]]),
      ),
    );
  }
  async function handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    if (request.method === 'GET' && request.url === '/internal/jwks')
      return reply(response, 200, deps.signer.jwks);
    const e2eOn = deps.config.e2eSecret !== undefined;
    if (e2eOn && request.method === 'POST' && request.url === '/internal/e2e/session')
      return e2eSession(request, response);
    if (e2eOn && request.method === 'GET' && request.url === '/internal/e2e/members')
      return e2eMembers(request, response);
    return reply(response, 404, { error: 'not_found' });
  }
  return (request, response) => {
    void handle(request, response).catch(() => reply(response, 500, { error: 'internal' }));
  };
}
