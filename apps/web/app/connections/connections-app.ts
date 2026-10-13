import { createHash, randomBytes } from 'node:crypto';

import { IAP_ASSERTION_HEADER, oauthApiSchema } from '@agent-works/domain';

import { renderDocument } from '../html.js';

import ConnectionsPage from './page.js';

import type { ConnectionView } from './page.js';
import type { IncomingMessage, RequestListener, ServerResponse } from 'node:http';

type Session = {
  readonly csrf: string;
  readonly expiresAt: number;
  grant?: { state: string; codeVerifier: string };
};

type Options = { readonly apiUrl: string; readonly fetch?: typeof fetch };
const provider = 'google';
const scope = 'https://www.googleapis.com/auth/drive.readonly';
const cookieName = 'connections';
const callbackPath = '/oauth/callback';
const connectionsPath = '/connections';
const sessionLifetime = 30 * 60 * 1000;

export function createConnectionsApp(options: Options, fallback: RequestListener): RequestListener {
  const sessions = new Map<string, Session>();
  return (request, response) => {
    const url = URL.parse(request.url ?? '/', 'http://localhost');
    if (
      url === null ||
      (url.pathname !== callbackPath && !url.pathname.startsWith(connectionsPath))
    ) {
      fallback(request, response);
      return;
    }
    void handle(options, sessions, { request, response, url }).catch(() => {
      if (!response.headersSent) {
        response.writeHead(502, { 'content-type': 'text/plain; charset=utf-8' });
        response.end('The connection service is unavailable.');
      }
    });
  };
}

type Exchange = { request: IncomingMessage; response: ServerResponse; url: URL };

async function handle(
  options: Options,
  sessions: Map<string, Session>,
  exchange: Exchange,
): Promise<void> {
  const { request, response, url } = exchange;
  response.setHeader('cache-control', 'no-store');
  response.setHeader('referrer-policy', 'no-referrer');
  for (const [id, session] of sessions) {
    if (session.expiresAt <= Date.now()) sessions.delete(id);
  }
  const cookie = request.headers.cookie
    ?.split(';')
    .map((part) => part.trim())
    .find((part) => part.startsWith(`${cookieName}=`));
  const existing =
    cookie === undefined ? undefined : sessions.get(cookie.slice(cookieName.length + 1));
  if (request.method === 'GET' && url.pathname === callbackPath) {
    await callback(options, sessions, existing, exchange);
    return;
  }
  const session = existing ?? newSession(sessions, exchange);
  if (request.method === 'GET' && url.pathname === connectionsPath) {
    await renderPage(options, exchange, session);
    return;
  }
  if (
    request.method === 'POST' &&
    ['/connections/connect', '/connections/disconnect'].includes(url.pathname)
  ) {
    const form = await readForm(request);
    if (form?.get('csrf') !== session.csrf) {
      await renderPage(options, exchange, session, 'Invalid connection request.', 400);
      return;
    }
    await change(options, session, exchange);
    return;
  }
  response.writeHead(404);
  response.end('not found');
}

function newSession(sessions: Map<string, Session>, { request, response }: Exchange): Session {
  const id = randomBytes(32).toString('base64url');
  const session = {
    csrf: randomBytes(32).toString('base64url'),
    expiresAt: Date.now() + sessionLifetime,
  };
  sessions.set(id, session);
  const secure = request.headers['x-forwarded-proto'] === 'https';
  response.setHeader(
    'set-cookie',
    `${cookieName}=${id}; Path=/; HttpOnly; SameSite=Lax; Max-Age=1800${secure ? '; Secure' : ''}`,
  );
  return session;
}

async function change(options: Options, session: Session, exchange: Exchange): Promise<void> {
  if (exchange.url.pathname === '/connections/disconnect') {
    const result = await callApi(options, exchange.request, 'DELETE');
    if (
      result?.kind !== 'connection' ||
      result.provider !== provider ||
      result.status !== 'revoked'
    ) {
      await renderPage(options, exchange, session, 'Could not disconnect. Try again.', 502);
      return;
    }
    session.grant = undefined;
    redirect(exchange.response, connectionsPath);
    return;
  }
  const grant = {
    state: randomBytes(32).toString('base64url'),
    codeVerifier: randomBytes(32).toString('base64url'),
  };
  session.grant = undefined;
  const codeChallenge = createHash('sha256').update(grant.codeVerifier).digest('base64url');
  const result = await callApi(options, exchange.request, 'POST', {
    kind: 'start',
    provider,
    state: grant.state,
    codeChallenge,
    codeChallengeMethod: 'S256',
    scope,
  });
  if (
    result?.kind !== 'started' ||
    result.provider !== provider ||
    result.state !== grant.state ||
    result.codeChallenge !== codeChallenge
  ) {
    await renderPage(options, exchange, session, 'Could not start the connection. Try again.', 502);
    return;
  }
  const authorization = new URL(result.authorizationUrl);
  if (!['http:', 'https:'].includes(authorization.protocol)) {
    await renderPage(options, exchange, session, 'Invalid authorization URL.', 502);
    return;
  }
  session.grant = grant;
  redirect(exchange.response, authorization.toString());
}

async function callback(
  options: Options,
  sessions: Map<string, Session>,
  session: Session | undefined,
  exchange: Exchange,
): Promise<void> {
  const { url, response, request } = exchange;
  const grant = session?.grant;
  if (
    session === undefined ||
    grant === undefined ||
    url.searchParams.get('state') !== grant.state
  ) {
    await renderPage(
      options,
      exchange,
      session ?? newSession(sessions, exchange),
      'Invalid or expired authorization state.',
      400,
    );
    return;
  }
  session.grant = undefined;
  const code = url.searchParams.get('code');
  if (url.searchParams.has('error') || code === null || code.length === 0) {
    await renderPage(
      options,
      exchange,
      session,
      'Authorization was not completed. Try again.',
      400,
    );
    return;
  }
  const result = await callApi(options, request, 'POST', {
    kind: 'callback',
    provider,
    state: grant.state,
    code,
    codeVerifier: grant.codeVerifier,
  });
  if (result?.kind !== 'connection' || result.provider !== provider) {
    await renderPage(
      options,
      exchange,
      session,
      'Could not complete the connection. Try again.',
      502,
    );
    return;
  }
  redirect(response, connectionsPath);
}

async function callApi(options: Options, request: IncomingMessage, method: string, body?: unknown) {
  const assertion = Reflect.get(request.headers, IAP_ASSERTION_HEADER) as unknown;
  const response = await (options.fetch ?? fetch)(
    new URL(
      method === 'GET' ? '/v1/oauth/connections' : `/v1/oauth/connections/${provider}`,
      options.apiUrl,
    ),
    {
      method,
      cache: 'no-store',
      headers: {
        'content-type': 'application/json',
        ...(typeof assertion === 'string' ? { [IAP_ASSERTION_HEADER]: assertion } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(2500),
    },
  );
  if (!response.ok) return undefined;
  const payload: unknown = await response.json();
  const parsed = oauthApiSchema.safeParse(payload);
  return parsed.success ? parsed.data : undefined;
}

async function readForm(request: IncomingMessage): Promise<URLSearchParams | undefined> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const value of request) {
    const chunk = Buffer.from(value as Uint8Array);
    size += chunk.length;
    if (size > 4096) return undefined;
    chunks.push(chunk);
  }
  return new URLSearchParams(Buffer.concat(chunks).toString('utf8'));
}

async function renderPage(
  options: Options,
  exchange: Exchange,
  session: Pick<Session, 'csrf'>,
  message?: string,
  status = 200,
): Promise<void> {
  const { request, response } = exchange;
  const result = await callApi(options, request, 'GET').catch(() => undefined);
  if (result?.kind !== 'connections') {
    sendPage(
      response,
      { csrf: session.csrf, status: 'unavailable' },
      message ?? 'Could not load connections. Refresh to try again.',
      status === 200 ? 502 : status,
    );
    return;
  }
  const connection = result.connections.find((item) => item.provider === provider);
  sendPage(
    response,
    { csrf: session.csrf, status: connection?.status, scope: connection?.scope },
    message,
    status,
  );
}

function sendPage(
  response: ServerResponse,
  view: ConnectionView,
  message?: string,
  status = 200,
): void {
  response.writeHead(status, { 'content-type': 'text/html; charset=utf-8' });
  response.end(renderDocument(ConnectionsPage({ view: { ...view, message } })));
}

function redirect(response: ServerResponse, location: string): void {
  response.writeHead(303, { location });
  response.end();
}
