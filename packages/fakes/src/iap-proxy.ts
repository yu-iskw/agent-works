import { createHash, createSign, generateKeyPairSync } from 'node:crypto';

import { header } from './http.js';

import type { Handler } from './http.js';
import type { KeyObject } from 'node:crypto';

const users = new Set(['alice', 'bob']);
const skip = new Set([
  'host',
  'content-length',
  'connection',
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
  const signer = createSign('SHA256');
  signer.update(input);
  signer.end();
  const signature = signer.sign({ key, dsaEncoding: 'ieee-p1363' }).toString('base64url');
  return `${input}.${signature}`;
}

async function forward(
  upstream: string,
  request: Parameters<Handler>[0],
  assertion: string,
): Promise<{ status: number; body: unknown }> {
  const headers = new Headers();
  for (const [name, value] of Object.entries(request.headers)) {
    if (value === undefined || skip.has(name) || name.startsWith('x-goog-authenticated-user')) {
      continue;
    }
    headers.set(name, Array.isArray(value) ? value.join(',') : value);
  }
  headers.set('x-goog-iap-jwt-assertion', assertion);
  const method = request.method;
  const response = await fetch(new URL(`${request.url.pathname}${request.url.search}`, upstream), {
    method,
    headers,
    body: method === 'GET' || method === 'HEAD' ? undefined : new Uint8Array(request.body),
  });
  const text = await response.text();
  if ((response.headers.get('content-type') ?? '').includes('application/json')) {
    return { status: response.status, body: JSON.parse(text) as unknown };
  }
  return { status: response.status, body: text };
}
