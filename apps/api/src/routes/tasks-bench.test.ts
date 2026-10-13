import { generateKeyPairSync, randomUUID, sign } from 'node:crypto';

import { IAP_ASSERTION_HEADER } from '@agent-works/domain';
import { listen } from '@agent-works/fakes';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createIapVerifier } from '../auth/iap.js';
import { createMemoryTaskPorts } from '../ports/memory/task-ports.js';
import { createSkillRegistry } from '../skills/registry.js';
import { taskAuthorization } from '../testing/task-authorization.js';

import { createTaskRoutes } from './tasks.js';

import type { ApiReply } from '../http.js';
import type { TaskRoutes } from './tasks.js';
import type { KeyObject } from 'node:crypto';

const budgetMs = 40;
const samples = 20;
const issuer = 'https://fake-iap.local';
const audience = 'agent-works-dev';

const submit = {
  kind: 'submit',
  objective: 'Summarize the runbook',
  skillId: 'ask',
  sourceAllowlist: ['drive'],
  requestedOutputs: ['answer'],
  executionPolicy: { mode: 'interactive', budgetUsd: 0.1, deadlineSeconds: 30 },
};

describe('tasks bench', () => {
  let routes: TaskRoutes;
  let assertion: string;
  let closeJwks: () => Promise<void>;

  beforeAll(async () => {
    const keys = keypair();
    const jwks = await listen(() => ({ status: 200, body: { keys: [keys.jwk] } }), 0);
    closeJwks = jwks.close;
    assertion = signedAssertion(keys.privateKey, keys.jwk.kid);
    const ports = createMemoryTaskPorts();
    routes = createTaskRoutes(
      ports.ledger,
      createIapVerifier({ jwksUrl: `${jwks.url}/jwks`, issuer, audience }),
      createSkillRegistry([
        {
          manifest: { id: 'ask', version: '1', state: 'PUBLISHED', tools: ['drive.search'] },
          validate: () => true,
          dispatch: () => Promise.resolve(),
        },
      ]),
      taskAuthorization,
      ports.dispatch,
    );
  });

  afterAll(async () => {
    await closeJwks();
  });

  it('keeps create-task p95 at or below 40 ms', async () => {
    const body = Buffer.from(JSON.stringify(submit));
    for (let warmup = 0; warmup < 5; warmup += 1) {
      expect((await create(routes, assertion, body)).status).toBe(200);
    }
    const durations: number[] = [];
    for (let sample = 0; sample < samples; sample += 1) {
      const started = performance.now();
      const reply = await create(routes, assertion, body);
      durations.push(performance.now() - started);
      expect(reply.status).toBe(200);
    }
    durations.sort((left, right) => left - right);
    const p95 = durations[Math.ceil(samples * 0.95) - 1];
    expect(p95).toBeLessThanOrEqual(budgetMs);
  });
});

function create(routes: TaskRoutes, assertion: string, body: Buffer): Promise<ApiReply> {
  return routes.submit({
    method: 'POST',
    path: '/v1/tasks',
    headers: {
      'idempotency-key': randomUUID(),
      [IAP_ASSERTION_HEADER]: assertion,
    },
    body,
  });
}

function keypair(): {
  readonly privateKey: KeyObject;
  readonly jwk: { kty: 'EC'; crv: 'P-256'; x: string; y: string; kid: string };
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
    jwk: { kty: 'EC', crv: 'P-256', x: exported.x, y: exported.y, kid: 'bench' },
  };
}

function signedAssertion(key: KeyObject, kid: string): string {
  const nowSec = Math.floor(Date.now() / 1000);
  const head = Buffer.from(JSON.stringify({ alg: 'ES256', kid })).toString('base64url');
  const body = Buffer.from(
    JSON.stringify({ iss: issuer, aud: audience, sub: 'alice', iat: nowSec, exp: nowSec + 3600 }),
  ).toString('base64url');
  const input = `${head}.${body}`;
  const signature = sign('sha256', Buffer.from(input), { key, dsaEncoding: 'ieee-p1363' }).toString(
    'base64url',
  );
  return `${input}.${signature}`;
}
