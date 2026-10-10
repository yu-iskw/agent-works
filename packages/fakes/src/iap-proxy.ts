import { createHash, generateKeyPairSync, sign } from 'node:crypto';

import { header } from './http.js';

import type { Handler, Reply, Request } from './http.js';
import type { KeyObject } from 'node:crypto';

const users = new Set(['alice', 'bob']);
const hop = new Set(['connection', 'content-length', 'keep-alive', 'transfer-encoding']);
const dropResponse = new Set([...hop, 'content-encoding']);
const skip = new Set([
  ...hop,
  'host',
  'upgrade',
  'expect',
  'x-fake-user',
  'x-goog-iap-jwt-assertion',
]);

export function createIapProxy(upstream: string): Handler {
  const { publicKey, privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const jwk = publicJwk(publicKey);
  return async (request) => {
    if (request.method === 'GET' && request.url.pathname === '/jwks') {
      return { status: 200, body: { keys: [jwk] } };
    }
    const user = header(request.headers, 'x-fake-user');
    if (user === undefined || !users.has(user)) {
      return { status: 401, body: { error: 'unauthenticated' } };
    }
    return forward(upstream, request, signAssertion(privateKey, jwk.kid, user));
  };
}

function publicJwk(publicKey: KeyObject) {
  const { kty, crv, x, y } = publicKey.export({ format: 'jwk' });
  if (kty === undefined || crv === undefined || x === undefined || y === undefined) {
    throw new Error('jwk');
  }
  const kid = createHash('sha256').update(`${x}.${y}`).digest('hex').slice(0, 8);
  return { kty, crv, x, y, kid, alg: 'ES256' as const, use: 'sig' as const };
}

function signAssertion(key: KeyObject, kid: string, sub: string): string {
  const iat = Math.floor(Date.now() / 1000);
  const head = Buffer.from(JSON.stringify({ alg: 'ES256', kid, typ: 'JWT' })).toString('base64url');
  const payload = Buffer.from(
    JSON.stringify({
      iss: 'https://fake-iap.local',
      aud: 'agent-works-dev',
      sub,
      email: `${sub}@example.test`,
      iat,
      exp: iat + 600,
    }),
  ).toString('base64url');
  const input = `${head}.${payload}`;
  const signature = sign('SHA256', Buffer.from(input), { key, dsaEncoding: 'ieee-p1363' }).toString(
    'base64url',
  );
  return `${input}.${signature}`;
}

async function forward(upstream: string, request: Request, assertion: string): Promise<Reply> {
  const base = new URL(upstream);
  const target = new URL(`${request.url.pathname}${request.url.search}`, base);
  if (target.origin !== base.origin) return { status: 400, body: { error: 'bad path' } };
  const headers = new Headers();
  for (const [name, value] of Object.entries(request.headers)) {
    if (value === undefined || skip.has(name) || name.startsWith('x-goog-authenticated-user')) {
      continue;
    }
    headers.set(name, Array.isArray(value) ? value.join(',') : value);
  }
  headers.set('x-goog-iap-jwt-assertion', assertion);
  const method = request.method;
  const response = await fetch(target, {
    method,
    headers,
    redirect: 'manual',
    body: method === 'GET' || method === 'HEAD' ? undefined : new Uint8Array(request.body),
  });
  return readUpstream(response);
}

async function readUpstream(response: Response): Promise<Reply> {
  const text = await response.text();
  const json =
    text.length > 0 && (response.headers.get('content-type') ?? '').includes('application/json');
  return {
    status: response.status,
    body: json ? (JSON.parse(text) as unknown) : text,
    headers: replyHeaders(response, text.length === 0),
  };
}

function replyHeaders(response: Response, empty: boolean): Record<string, string> | undefined {
  const entries: [string, string][] = [];
  if (empty) {
    response.headers.forEach((value, name) => {
      if (!dropResponse.has(name)) entries.push([name, value]);
    });
  } else {
    const location = response.headers.get('location');
    if (location !== null) entries.push(['location', location]);
  }
  return entries.length === 0 ? undefined : Object.fromEntries(entries);
}
