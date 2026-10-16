import { createHash, generateKeyPairSync, sign } from 'node:crypto';

import { IAP_ASSERTION_HEADER } from '@agent-works/domain';

import { header } from './http.js';

import type { Handler, Reply, ReplyHeaders, Request } from './http.js';
import type { KeyObject } from 'node:crypto';

export const fakeIap = {
  issuer: 'https://fake-iap.local',
  audience: 'agent-works-dev',
} as const;

export const fakeUsers = ['alice', 'bob'] as const;

const users = new Set<string>(fakeUsers);
const contentTypeHeader = 'content-type';
const textMediaTypes = new Set(['application/json', 'application/javascript', 'application/xml']);
const hop = new Set(['connection', 'content-length', 'keep-alive', 'transfer-encoding']);
const dropResponse = new Set([...hop, 'content-encoding']);
const skip = new Set([
  ...hop,
  'host',
  'upgrade',
  'expect',
  'x-fake-user',
  'x-fake-iap',
  IAP_ASSERTION_HEADER,
]);

type Fault = 'bad-sig' | 'bad-aud' | 'expired';

type SigningKeys = {
  jwk: ReturnType<typeof publicJwk>;
  privateKey: KeyObject;
  decoyKey: KeyObject;
};

export function createIapProxy(upstream: string): Handler {
  const signing = createSigningKeys();
  return async (request) => {
    if (request.method === 'GET' && request.url.pathname === '/jwks') {
      return { status: 200, body: { keys: [signing.jwk] } };
    }
    const user = header(request.headers, 'x-fake-user');
    if (user === undefined || !users.has(user)) {
      return { status: 401, body: { error: 'unauthenticated' } };
    }
    const fault = readFault(header(request.headers, 'x-fake-iap'));
    if (fault === 'invalid') return { status: 400, body: { error: 'bad iap switch' } };
    return forward(upstream, request, signAssertion(signing, user, fault));
  };
}

function createSigningKeys(): SigningKeys {
  const { publicKey, privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const { privateKey: decoyKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  return { jwk: publicJwk(publicKey), privateKey, decoyKey };
}

function readFault(value: string | undefined): Fault | 'invalid' | undefined {
  switch (value) {
    case undefined:
      return undefined;
    case 'bad-sig':
    case 'bad-aud':
    case 'expired':
      return value;
    default:
      return 'invalid';
  }
}

function publicJwk(publicKey: KeyObject) {
  const { kty, crv, x, y } = publicKey.export({ format: 'jwk' });
  if (kty === undefined || crv === undefined || x === undefined || y === undefined) {
    throw new Error('jwk');
  }
  const kid = createHash('sha256').update(`${x}.${y}`).digest('hex').slice(0, 8);
  return { kty, crv, x, y, kid, alg: 'ES256' as const, use: 'sig' as const };
}

function signAssertion(signing: SigningKeys, sub: string, fault: Fault | undefined): string {
  const key = fault === 'bad-sig' ? signing.decoyKey : signing.privateKey;
  const head = Buffer.from(
    JSON.stringify({ alg: 'ES256', kid: signing.jwk.kid, typ: 'JWT' }),
  ).toString('base64url');
  const payload = Buffer.from(JSON.stringify(assertionClaims(sub, fault))).toString('base64url');
  const input = `${head}.${payload}`;
  const signature = sign('SHA256', Buffer.from(input), { key, dsaEncoding: 'ieee-p1363' }).toString(
    'base64url',
  );
  return `${input}.${signature}`;
}

function assertionClaims(
  sub: string,
  fault: Fault | undefined,
): {
  iss: string;
  aud: string;
  sub: string;
  email: string;
  iat: number;
  exp: number;
} {
  const now = Math.floor(Date.now() / 1000);
  const identity = { iss: fakeIap.issuer, sub, email: `${sub}@example.test` };
  switch (fault) {
    case undefined:
    case 'bad-sig':
      return { ...identity, aud: fakeIap.audience, iat: now, exp: now + 600 };
    case 'bad-aud':
      return { ...identity, aud: 'agent-works-other', iat: now, exp: now + 600 };
    case 'expired':
      return { ...identity, aud: fakeIap.audience, iat: now - 180, exp: now - 120 };
    default: {
      const unreachable: never = fault;
      return unreachable;
    }
  }
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
  headers.set(IAP_ASSERTION_HEADER, assertion);
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
  const bytes = new Uint8Array(await response.arrayBuffer());
  const type = mediaType(response.headers.get(contentTypeHeader));
  if (!type.startsWith('text/') && !textMediaTypes.has(type)) {
    return {
      status: response.status,
      body: bytes,
      headers: replyHeaders(response, bytes.byteLength === 0),
    };
  }
  const text = new TextDecoder().decode(bytes);
  const json = text.length > 0 && type === 'application/json';
  return {
    status: response.status,
    body: json ? (JSON.parse(text) as unknown) : text,
    headers: replyHeaders(response, text.length === 0),
  };
}

function mediaType(value: string | null): string {
  const [type = ''] = (value ?? '').split(';');
  return type.trim().toLowerCase();
}

function replyHeaders(response: Response, empty: boolean): ReplyHeaders | undefined {
  const entries: [string, string][] = [];
  if (empty) {
    response.headers.forEach((value, name) => {
      if (name === 'set-cookie' || dropResponse.has(name)) return;
      entries.push([name, value]);
    });
  } else {
    const location = response.headers.get('location');
    if (location !== null) entries.push(['location', location]);
    const contentType = response.headers.get(contentTypeHeader);
    if (contentType !== null) entries.push([contentTypeHeader, contentType]);
  }
  const cookies = response.headers.getSetCookie();
  if (entries.length === 0 && cookies.length === 0) return undefined;
  const headers: ReplyHeaders = Object.fromEntries(entries);
  return cookies.length === 0 ? headers : { ...headers, 'set-cookie': cookies };
}
