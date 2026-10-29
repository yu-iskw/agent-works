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

function reply(response: ServerResponse, status: number, payload: unknown): void {
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  });
  response.end(JSON.stringify(payload));
}

/**
 * The internal listener: the member-assertion JWKS for the segment APIs, and the e2e session
 * endpoint. Compose never publishes this port. The e2e route fails closed: without
 * AW_E2E_MODE=1 and a configured secret (`config.e2eSecret`) it answers 404 like any unknown path.
 */
export function createInternalHandler(deps: {
  readonly config: Pick<WebConfig, 'e2eSecret'>;
  readonly identity: Pick<Identity, 'e2eSession'>;
  readonly signer: Pick<AssertionSigner, 'jwks'>;
}): RequestListener {
  async function e2eSession(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const input = (await body(request)) as { email?: unknown } | undefined;
    const secret = request.headers['x-e2e-secret'];
    try {
      const done = await deps.identity.e2eSession(
        typeof secret === 'string' ? secret : undefined,
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
  async function handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    if (request.method === 'GET' && request.url === '/internal/jwks')
      return reply(response, 200, deps.signer.jwks);
    if (
      request.method === 'POST' &&
      request.url === '/internal/e2e/session' &&
      deps.config.e2eSecret !== undefined
    )
      return e2eSession(request, response);
    return reply(response, 404, { error: 'not_found' });
  }
  return (request, response) => {
    void handle(request, response).catch(() => reply(response, 500, { error: 'internal' }));
  };
}
