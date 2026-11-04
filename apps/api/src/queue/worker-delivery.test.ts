import { generateKeyPairSync, sign } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { Unavailable } from '../auth/iap.js';
import { createServiceIdentityPolicy } from '../auth/service-identity.js';

import { createRs256JwksVerifier } from './rs256-jwks-verifier.js';
import { createDeliveryHandler } from './worker-delivery.js';

import type { DeliveryStore, HandoffOutcome } from './worker-delivery.js';
import type { KeyObject } from 'node:crypto';

const audience = 'https://aw-worker-abc123-an.a.run.app/internal/deliveries';
const dispatcher = 'aw-dispatcher@aw-dev.iam.gserviceaccount.com';
const now = 1_800_000_000_000;
const nowSec = now / 1000;
const policy = createServiceIdentityPolicy({ audience, authorizedEmails: [dispatcher] });

const goodKey = generateKeyPairSync('rsa', { modulusLength: 2048 });
const otherKey = generateKeyPairSync('rsa', { modulusLength: 2048 });

const b64 = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');

function mint(
  overrides: Record<string, unknown> = {},
  options: { key?: KeyObject; kid?: string; alg?: string } = {},
): string {
  const claims = {
    iss: 'https://accounts.google.com',
    aud: audience,
    sub: '123456789012345678901',
    email: dispatcher,
    email_verified: true,
    iat: nowSec - 10,
    exp: nowSec + 3000,
    ...overrides,
  };
  const head = `${b64({ alg: options.alg ?? 'RS256', kid: options.kid ?? 'k1', typ: 'JWT' })}.${b64(claims)}`;
  const signature = sign('sha256', Buffer.from(head), options.key ?? goodKey.privateKey);
  return `${head}.${signature.toString('base64url')}`;
}

function jwksFetch(calls: { count: number }, failing = false): typeof fetch {
  const jwk = goodKey.publicKey.export({ format: 'jwk' });
  return () => {
    calls.count += 1;
    if (failing) return Promise.reject(new Error('network down'));
    return Promise.resolve(
      Response.json({ keys: [{ ...jwk, kid: 'k1', use: 'sig', alg: 'RS256' }] }),
    );
  };
}

const executionId = 'b'.repeat(64);
const body = JSON.stringify({ schemaVersion: 1, executionId, dispatchId: 'd-0001' });

type Probe = {
  store: DeliveryStore;
  handoffs: string[];
  rejections: string[];
  outcome: HandoffOutcome;
  failHandoff: boolean;
  failRecord: boolean;
  settled: boolean;
};

function probe(): Probe {
  const p: Probe = {
    handoffs: [],
    rejections: [],
    outcome: 'accepted',
    failHandoff: false,
    failRecord: false,
    settled: false,
    store: {
      async handoff({ envelope }) {
        p.handoffs.push(envelope.executionId);
        await new Promise((resolve) => setTimeout(resolve, 5));
        if (p.failHandoff) throw new Error('db down');
        p.settled = true;
        return p.outcome;
      },
      async recordRejected({ reason }) {
        await Promise.resolve();
        if (p.failRecord) throw new Error('db down');
        p.rejections.push(reason);
      },
    },
  };
  return p;
}

function setup(failingJwks = false) {
  const p = probe();
  const calls = { count: 0 };
  const handle = createDeliveryHandler({
    verifyIdToken: createRs256JwksVerifier({
      fetch: jwksFetch(calls, failingJwks),
      now: () => now,
    }),
    policy,
    store: p.store,
    now: () => now,
  });
  return { p, calls, handle };
}

const bearer = (token: string) => `Bearer ${token}`;

describe('worker delivery authentication', () => {
  it('accepts the dispatcher token and hands off through the store', async () => {
    const { p, handle } = setup();
    const response = await handle({ authorization: bearer(mint()), body });
    expect(response).toEqual({ status: 200, outcome: 'accepted' });
    expect(p.handoffs).toEqual([executionId]);
  });

  it.each([
    ['no header', undefined],
    ['non-bearer scheme', 'Basic abc'],
    ['garbage token', 'Bearer not.a.jwt'],
  ])('rejects %s with 401 before touching the store', async (_label, header) => {
    const { p, handle } = setup();
    expect((await handle({ authorization: header, body })).status).toBe(401);
    expect(p.handoffs).toEqual([]);
  });

  it.each([
    ['wrong issuer', mint({ iss: 'https://evil.example' }), 401],
    ['wrong audience', mint({ aud: 'https://other.run.app/x' }), 401],
    ['expired', mint({ exp: nowSec - 600, iat: nowSec - 4000 }), 401],
    ['unverified email', mint({ email_verified: false }), 401],
    ['wrong key signature', mint({}, { key: otherKey.privateKey }), 401],
    [
      'alg none',
      `${b64({ alg: 'none', kid: 'k1' })}.${b64({ iss: 'https://accounts.google.com' })}.x`,
      401,
    ],
    ['HS256 downgrade', mint({}, { alg: 'HS256' }), 401],
    ['unknown kid', mint({}, { kid: 'k-unknown' }), 401],
    ['other service account', mint({ email: 'rogue@aw-dev.iam.gserviceaccount.com' }), 403],
  ])('rejects %s with %i', async (_label, token, status) => {
    const { p, handle } = setup();
    const response = await handle({ authorization: bearer(token), body });
    expect(response.status).toBe(status);
    expect(p.handoffs).toEqual([]);
  });

  it('returns a retryable 503 when the key set cannot be fetched', async () => {
    const { p, handle } = setup(true);
    expect((await handle({ authorization: bearer(mint()), body })).status).toBe(503);
    expect(p.handoffs).toEqual([]);
  });

  it('caches keys between deliveries', async () => {
    const { calls, handle } = setup();
    await handle({ authorization: bearer(mint()), body });
    await handle({ authorization: bearer(mint()), body });
    expect(calls.count).toBe(1);
  });

  it('maps a thrown Unavailable from a custom verifier to 503', async () => {
    const handle = createDeliveryHandler({
      verifyIdToken: () => Promise.reject(new Unavailable('x')),
      policy,
      store: probe().store,
      now: () => now,
    });
    expect((await handle({ authorization: bearer('a.b.c'), body })).status).toBe(503);
  });
});

describe('worker delivery envelope and durability', () => {
  const auth = () => bearer(mint());

  it('acknowledges a duplicate delivery of a terminal execution without new work', async () => {
    const { p, handle } = setup();
    p.outcome = 'already-terminal';
    expect(await handle({ authorization: auth(), body })).toEqual({
      status: 200,
      outcome: 'already-terminal',
    });
  });

  it('asks for redelivery while the execution is in progress or not yet visible', async () => {
    const { p, handle } = setup();
    p.outcome = 'in-progress';
    expect((await handle({ authorization: auth(), body })).status).toBe(503);
    p.outcome = 'unknown-execution';
    expect((await handle({ authorization: auth(), body })).status).toBe(503);
  });

  it('defers an unknown newer schema version with a retryable status and records nothing', async () => {
    const { p, handle } = setup();
    const v2 = JSON.stringify({ schemaVersion: 2, executionId, dispatchId: 'd-1', extra: true });
    expect(await handle({ authorization: auth(), body: v2 })).toEqual({
      status: 503,
      outcome: 'unsupported-version',
    });
    expect(p.rejections).toEqual([]);
    expect(p.handoffs).toEqual([]);
  });

  it.each([
    ['malformed json', '{nope', 'malformed'],
    [
      'unknown field',
      JSON.stringify({ schemaVersion: 1, executionId, dispatchId: 'd', prompt: 'x' }),
      'invalid',
    ],
    ['version zero', JSON.stringify({ schemaVersion: 0, executionId, dispatchId: 'd' }), 'invalid'],
    [
      'oversize',
      JSON.stringify({ schemaVersion: 1, executionId, dispatchId: 'd', pad: 'x'.repeat(600) }),
      'too-large',
    ],
  ])(
    'acknowledges permanent poison (%s) only after recording it',
    async (_label, poison, reason) => {
      const { p, handle } = setup();
      expect(await handle({ authorization: auth(), body: poison })).toEqual({
        status: 200,
        outcome: `rejected:${reason}`,
      });
      expect(p.rejections).toEqual([reason]);
      expect(p.handoffs).toEqual([]);
    },
  );

  it('does not acknowledge poison when the rejection cannot be recorded', async () => {
    const { p, handle } = setup();
    p.failRecord = true;
    expect((await handle({ authorization: auth(), body: '{nope' })).status).toBe(503);
  });

  it('never responds 2xx before the persistence port settles, and leaves no work behind', async () => {
    const { p, handle } = setup();
    const response = await handle({ authorization: auth(), body });
    expect(response.status).toBe(200);
    expect(p.settled).toBe(true);
  });

  it('returns a retryable status when the persistence port fails', async () => {
    const { p, handle } = setup();
    p.failHandoff = true;
    expect(await handle({ authorization: auth(), body })).toEqual({
      status: 503,
      outcome: 'handoff-failed',
    });
    expect(p.settled).toBe(false);
  });

  it('resolves the execution from the envelope reference only, never trusting extra payload', async () => {
    const { p, handle } = setup();
    await handle({ authorization: auth(), body });
    expect(p.handoffs).toEqual([executionId]);
  });
});
