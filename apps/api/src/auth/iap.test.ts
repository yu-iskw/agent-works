import { generateKeyPairSync, randomUUID, sign } from 'node:crypto';

import { IAP_ASSERTION_HEADER } from '@agent-works/domain';
import { listen } from '@agent-works/fakes';
import { afterEach, describe, expect, it } from 'vitest';

import { startStack } from '../testing/stack.js';

import { Unavailable, createIapVerifier } from './iap.js';

import type { VerifyAssertion } from './iap.js';
import type { Stack } from '../testing/stack.js';
import type { KeyObject } from 'node:crypto';

const issuer = 'https://fake-iap.local';
const audience = 'agent-works-dev';
const frozenNow = 1_700_000_000_000;
const triageQuestion = 'What are the triage runbook steps?';

describe('IAP verifier', () => {
  const closers: (() => Promise<void>)[] = [];
  const stacks: Stack[] = [];

  afterEach(async () => {
    const open = closers.splice(0);
    for (const close of open) await close();
    const running = stacks.splice(0);
    for (const stack of running) await stack.close();
  });

  it('returns unavailable when a published key is not a public key', async () => {
    const jwks = await listen(
      () => ({
        status: 200,
        body: { keys: [{ kty: 'EC', crv: 'P-256', x: 'AAAA', y: 'AAAA', kid: 'k' }] },
      }),
      0,
    );
    closers.push(jwks.close);
    const verify = createIapVerifier({ jwksUrl: `${jwks.url}/jwks`, issuer, audience });
    await expect(verify(token('k'))).rejects.toBeInstanceOf(Unavailable);
  });

  it('returns unavailable when the key set is empty', async () => {
    const jwks = await listen(() => ({ status: 200, body: { keys: [] } }), 0);
    closers.push(jwks.close);
    const verify = createIapVerifier({ jwksUrl: `${jwks.url}/jwks`, issuer, audience });
    await expect(verify(token('k'))).rejects.toBeInstanceOf(Unavailable);
  });

  it('rejects a cached kid after it leaves the jwks and the refresh window passes', async () => {
    const active = keypair('active');
    const rotated = keypair('rotated');
    const published = { keys: [active.jwk] };
    let now = 1_700_000_000_000;
    const jwks = await listen(() => ({ status: 200, body: { keys: published.keys } }), 0);
    closers.push(jwks.close);
    const verify = createIapVerifier({
      jwksUrl: `${jwks.url}/jwks`,
      issuer,
      audience,
      now: () => now,
    });
    const assertion = signedAssertion(active.privateKey, active.jwk.kid, now);
    await expect(verify(assertion)).resolves.toMatchObject({ sub: 'alice' });

    published.keys = [rotated.jwk];
    now += 4_999;
    await expect(verify(assertion)).resolves.toMatchObject({ sub: 'alice' });

    now += 1;
    await expect(verify(assertion)).rejects.toMatchObject({
      name: 'Unauthenticated',
      reason: 'unknown_key',
    });
  });

  it('bad-sig', async () => {
    const active = keypair('active');
    const decoy = keypair('decoy');
    const verify = verifierFor(active.jwk);
    const validToken = signedAssertion(active.privateKey, active.jwk.kid, frozenNow);
    await expect(verify(validToken)).resolves.toStrictEqual({
      sub: 'alice',
      assertion: validToken,
    });
    const forged = signedAssertion(decoy.privateKey, active.jwk.kid, frozenNow);
    await expect(verify(forged)).rejects.toMatchObject({
      name: 'Unauthenticated',
      reason: 'bad_signature',
    });
  });

  it('bad-aud', async () => {
    const active = keypair('active');
    const verify = verifierFor(active.jwk);
    const validToken = signedAssertion(active.privateKey, active.jwk.kid, frozenNow);
    await expect(verify(validToken)).resolves.toStrictEqual({
      sub: 'alice',
      assertion: validToken,
    });
    const wrongAudience = signedAssertion(active.privateKey, active.jwk.kid, frozenNow, {
      ...validClaims(frozenNow),
      aud: 'agent-works-other',
    });
    await expect(verify(wrongAudience)).rejects.toMatchObject({
      name: 'Unauthenticated',
      reason: 'bad_claims',
    });
  });

  it('expired', async () => {
    const active = keypair('active');
    const verify = verifierFor(active.jwk);
    const validToken = signedAssertion(active.privateKey, active.jwk.kid, frozenNow);
    await expect(verify(validToken)).resolves.toStrictEqual({
      sub: 'alice',
      assertion: validToken,
    });
    const nowSec = Math.floor(frozenNow / 1000);
    const stale = signedAssertion(active.privateKey, active.jwk.kid, frozenNow, {
      ...validClaims(frozenNow),
      iat: nowSec - 180,
      exp: nowSec - 120,
    });
    await expect(verify(stale)).rejects.toMatchObject({
      name: 'Unauthenticated',
      reason: 'expired',
    });
  });

  it('missing-sub', async () => {
    const active = keypair('active');
    const verify = verifierFor(active.jwk);
    const validToken = signedAssertion(active.privateKey, active.jwk.kid, frozenNow);
    await expect(verify(validToken)).resolves.toStrictEqual({
      sub: 'alice',
      assertion: validToken,
    });
    const nowSec = Math.floor(frozenNow / 1000);
    const missingSub = signedAssertion(active.privateKey, active.jwk.kid, frozenNow, {
      iss: issuer,
      aud: audience,
      iat: nowSec,
      exp: nowSec + 3600,
    });
    await expect(verify(missingSub)).rejects.toMatchObject({
      name: 'Unauthenticated',
      reason: 'bad_claims',
    });
  });

  it('email-change', async () => {
    const active = keypair('active');
    const verify = verifierFor(active.jwk);
    const example = signedAssertion(active.privateKey, active.jwk.kid, frozenNow, {
      ...validClaims(frozenNow),
      email: 'alice@example.test',
    });
    const other = signedAssertion(active.privateKey, active.jwk.kid, frozenNow, {
      ...validClaims(frozenNow),
      email: 'alice@other.test',
    });
    await expect(verify(example)).resolves.toStrictEqual({
      sub: 'alice',
      assertion: example,
      email: 'alice@example.test',
    });
    await expect(verify(other)).resolves.toStrictEqual({
      sub: 'alice',
      assertion: other,
      email: 'alice@other.test',
    });
    expect(example).not.toEqual(other);
  });

  it('returns 401 and writes nothing for an email header without an assertion', async () => {
    const stack = await openStack(stacks);
    const requestId = randomUUID();
    const response = await postAsk(
      stack.apiUrl,
      { 'x-goog-authenticated-user-email': 'mallory@example.test' },
      requestId,
    );
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: 'unauthenticated' });
    expect(stack.audit.rows()).toEqual([]);
  });

  it('returns 401 and writes nothing when the assertion is not a jwt', async () => {
    const stack = await openStack(stacks);
    const requestId = randomUUID();
    const response = await postAsk(stack.apiUrl, { [IAP_ASSERTION_HEADER]: 'forged' }, requestId);
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: 'unauthenticated' });
    expect(stack.audit.rows()).toEqual([]);
  });

  it('returns 200 and one audit row when the fake proxy presents alice', async () => {
    const stack = await openStack(stacks);
    const requestId = randomUUID();
    const response = await postAsk(
      stack.iapUrl,
      { 'content-type': 'application/json', 'x-fake-user': 'alice' },
      requestId,
    );
    expect(response.status).toBe(200);
    expect(stack.audit.rows().map((row) => row.initiatorSubject)).toEqual(['alice']);
  });

  it('auth', async () => {
    const active = keypair('active');
    const fetches = { count: 0 };
    const verify = verifierFor(active.jwk, fetches);
    const assertion = signedAssertion(active.privateKey, active.jwk.kid, frozenNow);
    await expect(verify(assertion)).resolves.toStrictEqual({ sub: 'alice', assertion });
    for (let warmup = 0; warmup < 20; warmup += 1) {
      await verify(assertion);
    }
    const timedCount = 200;
    const started = performance.now();
    for (let timed = 0; timed < timedCount; timed += 1) {
      await verify(assertion);
    }
    const mean = (performance.now() - started) / timedCount;
    expect(fetches.count).toBe(1);
    expect(mean, `mean ${mean} ms`).toBeLessThanOrEqual(2);
  });
});

function keypair(kid: string): {
  readonly privateKey: KeyObject;
  readonly jwk: { kty: string; crv: string; x: string; y: string; kid: string };
} {
  const { publicKey, privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const exported = publicKey.export({ format: 'jwk' });
  if (
    exported.kty !== 'EC' ||
    exported.crv !== 'P-256' ||
    typeof exported.x !== 'string' ||
    typeof exported.y !== 'string'
  ) {
    throw new Error('jwk');
  }
  return {
    privateKey,
    jwk: { kty: exported.kty, crv: exported.crv, x: exported.x, y: exported.y, kid },
  };
}

function signedAssertion(
  key: KeyObject,
  kid: string,
  nowMs: number,
  claims?: Readonly<Record<string, string | number>>,
): string {
  const head = Buffer.from(JSON.stringify({ alg: 'ES256', kid })).toString('base64url');
  const body = Buffer.from(JSON.stringify(claims ?? validClaims(nowMs))).toString('base64url');
  const input = `${head}.${body}`;
  const signature = sign('sha256', Buffer.from(input), { key, dsaEncoding: 'ieee-p1363' }).toString(
    'base64url',
  );
  return `${input}.${signature}`;
}

function validClaims(nowMs: number): {
  readonly iss: string;
  readonly aud: string;
  readonly sub: string;
  readonly iat: number;
  readonly exp: number;
} {
  const nowSec = Math.floor(nowMs / 1000);
  return { iss: issuer, aud: audience, sub: 'alice', iat: nowSec, exp: nowSec + 3600 };
}

function verifierFor(
  jwk: ReturnType<typeof keypair>['jwk'],
  fetches?: { count: number },
): VerifyAssertion {
  return createIapVerifier({
    jwksUrl: 'https://iap.test/jwks',
    issuer,
    audience,
    now: () => frozenNow,
    fetch: () => {
      if (fetches !== undefined) fetches.count += 1;
      return Promise.resolve(Response.json({ keys: [jwk] }));
    },
  });
}

function token(kid: string): string {
  const head = Buffer.from(JSON.stringify({ alg: 'ES256', kid })).toString('base64url');
  const body = Buffer.from(
    JSON.stringify({ iss: issuer, aud: audience, sub: 'alice', iat: 1, exp: 4_102_444_800 }),
  ).toString('base64url');
  return `${head}.${body}.sig`;
}

async function openStack(stacks: Stack[]): Promise<Stack> {
  const stack = await startStack();
  stacks.push(stack);
  return stack;
}

function postAsk(
  url: string,
  headers: Readonly<Record<string, string>>,
  requestId: string,
): Promise<Response> {
  return fetch(`${url}/v1/ask`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ requestId, question: triageQuestion }),
  });
}
