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

const userCookie = 'aw_fake_user';
const signInPath = '/_auth/sign-in';

type Fault = 'bad-sig' | 'bad-aud' | 'expired';

export type IapProxyOptions = {
  /** Local browser sign-in: a cookie picks alice or bob. Off unless FAKE_IAP_SIGN_IN=1. */
  readonly signIn?: boolean;
};

type SigningKeys = {
  jwk: ReturnType<typeof publicJwk>;
  privateKey: KeyObject;
  decoyKey: KeyObject;
};

export function createIapProxy(upstream: string, options: IapProxyOptions = {}): Handler {
  const signing = createSigningKeys();
  return async (request) => {
    if (request.method === 'GET' && request.url.pathname === '/jwks') {
      return { status: 200, body: { keys: [signing.jwk] } };
    }
    if (options.signIn === true && request.url.pathname.startsWith('/_auth/'))
      return signIn(request);
    const user =
      header(request.headers, 'x-fake-user') ??
      (options.signIn === true ? cookieUser(request) : undefined);
    if (user === undefined || !users.has(user)) {
      if (options.signIn === true && request.method === 'GET')
        return { status: 303, body: '', headers: { location: signInPath } };
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
  const text = await response.text();
  const json =
    text.length > 0 && (response.headers.get(contentTypeHeader) ?? '').includes('application/json');
  return {
    status: response.status,
    body: json ? (JSON.parse(text) as unknown) : text,
    headers: replyHeaders(response),
  };
}

/** Like IAP, forwards every backend header; only hop-by-hop and framing headers are dropped. */
function replyHeaders(response: Response): ReplyHeaders | undefined {
  const entries: [string, string][] = [];
  response.headers.forEach((value, name) => {
    if (name === 'set-cookie' || dropResponse.has(name)) return;
    entries.push([name, value]);
  });
  const cookies = response.headers.getSetCookie();
  if (entries.length === 0 && cookies.length === 0) return undefined;
  const headers: ReplyHeaders = Object.fromEntries(entries);
  return cookies.length === 0 ? headers : { ...headers, 'set-cookie': cookies };
}

function cookieUser(request: Request): string | undefined {
  return header(request.headers, 'cookie')
    ?.split(';')
    .map((part) => part.trim())
    .find((part) => part.startsWith(`${userCookie}=`))
    ?.slice(userCookie.length + 1);
}

const signInPage = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Local sign-in · Agent Works</title><style>body{font:16px/1.5 system-ui,sans-serif;margin:0;display:grid;place-items:center;min-height:100vh;background:#f5f6f8;color:#16191f}main{background:#fff;border:1px solid #d9dde4;border-radius:12px;padding:32px;max-width:420px;width:calc(100% - 32px)}h1{font-size:1.4rem;margin:0 0 8px}p{color:#464e5b}button{display:block;width:100%;margin-top:12px;min-height:44px;font:inherit;font-weight:600;border-radius:8px;border:1px solid #2f54d6;background:#2f54d6;color:#fff;cursor:pointer}button.alt{background:#fff;color:#2341ad}button:focus-visible{outline:3px solid #2f54d6;outline-offset:2px}</style></head><body><main><h1>Local test sign-in</h1><p>This local-only proxy stands in for Google Cloud IAP. Pick a test identity. It never runs in production.</p><form method="post" action="/_auth/sign-in"><button name="user" value="alice">Continue as alice@example.test</button><button class="alt" name="user" value="bob">Continue as bob@example.test</button></form></main></body></html>`;

function signIn(request: Request): Reply {
  const path = request.url.pathname;
  if (request.method === 'GET' && path === signInPath)
    return {
      status: 200,
      body: signInPage,
      headers: { 'content-type': 'text/html; charset=utf-8' },
    };
  if (request.method === 'GET' && path === '/_auth/sign-out')
    return {
      status: 303,
      body: '',
      headers: {
        location: signInPath,
        'set-cookie': `${userCookie}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`,
      },
    };
  if (request.method === 'POST' && path === signInPath) {
    const user = new URLSearchParams(request.body.toString('utf8')).get('user');
    if (user === null || !users.has(user)) return { status: 400, body: 'unknown user' };
    return {
      status: 303,
      body: '',
      headers: {
        location: '/',
        'set-cookie': `${userCookie}=${user}; Path=/; HttpOnly; SameSite=Lax`,
      },
    };
  }
  return { status: 404, body: 'not found' };
}
