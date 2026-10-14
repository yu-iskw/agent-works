import { createServer } from 'node:http';

import { describe, expect, it } from 'vitest';

import { createMemoryAuditLog } from '../audit/write.js';
import { createArtifactsReadRoute } from '../routes/artifacts-read.js';

import { createGovernanceApp } from './runtime.js';
import {
  CREATED,
  governanceFixture,
  readContext,
  recordFixture,
  REQUEST_ID,
  SECRET,
} from './test-fixtures.js';

import type { GovernedArtifactReadDeps } from './artifact-route.js';
import type { GovernanceRuntimeDeps } from './runtime.js';
import type { Caller } from '../auth/iap.js';
import type { Route } from '../http.js';

const caller = { sub: 'alice', assertion: 'verified' } as Caller;
const now = () => new Date(CREATED);
function artifactRequest(id = 'artifact-1'): Parameters<Route>[0] {
  return { method: 'GET', path: `/v1/artifacts/${id}`, headers: {}, body: Buffer.alloc(0) };
}
describe('governed artifact route', () => {
  it('decrypts only after the trusted context matches the verified caller', async () => {
    const { store } = await governanceFixture();
    await store.put(recordFixture(), SECRET);
    const deps: GovernedArtifactReadDeps = {
      verify: () => Promise.resolve(caller),
      store,
      contextFor: () => Promise.resolve(readContext()),
    };
    expect(await createArtifactsReadRoute(deps)(artifactRequest())).toEqual({
      status: 200,
      body: { text: SECRET },
    });
    expect(
      (
        await createArtifactsReadRoute({
          ...deps,
          contextFor: () => Promise.resolve(readContext('bob')),
        })(artifactRequest())
      ).status,
    ).toBe(403);
    expect(
      (
        await createArtifactsReadRoute({
          ...deps,
          contextFor: () =>
            Promise.resolve({ ...readContext(), classificationCeiling: 'INTERNAL' }),
        })(artifactRequest())
      ).status,
    ).toBe(404);
  });
  it('key revocation returns a controlled failure with no ciphertext or plaintext', async () => {
    const { store, keys } = await governanceFixture();
    await store.put(recordFixture(), SECRET);
    keys.revoke('local-key-1');
    const route = createArtifactsReadRoute({
      verify: () => Promise.resolve(caller),
      store,
      contextFor: () => Promise.resolve(readContext()),
    });
    expect(await route(artifactRequest())).toEqual({
      status: 503,
      body: { error: 'artifact_key_unavailable' },
    });
  });
  it('unavailable and malformed artifact paths fail closed', async () => {
    const { store } = await governanceFixture();
    const route = createArtifactsReadRoute({
      verify: () => Promise.resolve(caller),
      store,
      contextFor: () => Promise.resolve(readContext()),
    });
    expect((await route(artifactRequest('absent'))).status).toBe(404);
    expect((await route({ ...artifactRequest(), path: '/not-artifact' })).status).toBe(404);
    expect((await route(artifactRequest('%ZZ'))).status).toBe(503);
  });
});
describe('offline governance HTTP composition', () => {
  it('mounts encrypted reads and trusted deletion routes beside the existing app', async () => {
    const { port, store } = await governanceFixture();
    await store.put(recordFixture(), SECRET);
    const verify = () => Promise.resolve(caller);
    const deps: GovernanceRuntimeDeps = {
      app: {
        verify,
        now,
        audit: createMemoryAuditLog(),
        drive: { retrieve: () => Promise.resolve([]) },
        runner: { run: () => Promise.reject(new Error('unused')) },
      },
      registration: {
        verify,
        now,
        governance: { port, rolesFor: () => Promise.resolve(['privacy-officer']) },
      },
      artifacts: { verify, store, contextFor: () => Promise.resolve(readContext()) },
    };
    const server = createServer(createGovernanceApp(deps));
    await new Promise<void>((resolve) => {
      server.listen(0, '127.0.0.1', resolve);
    });
    try {
      const address = server.address();
      if (address === null || typeof address === 'string') throw new Error('missing address');
      const base = `http://127.0.0.1:${address.port}`;
      const read = await fetch(`${base}/v1/artifacts/artifact-1`);
      expect(read.status).toBe(200);
      expect(read.headers.get('cache-control')).toBe('no-store');
      expect(await read.json()).toEqual({ text: SECRET });
      const requested = await fetch(`${base}/v1/admin/governance/deletions`, {
        method: 'POST',
        body: JSON.stringify({
          requestId: REQUEST_ID,
          subject: 'alice',
          reasonRef: 'privacy-case',
        }),
      });
      expect(requested.status).toBe(202);
      expect((await fetch(`${base}/v1/artifacts/artifact-1`)).status).toBe(404);
      expect((await fetch(`${base}/healthz`)).status).toBe(200);
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error === undefined ? resolve() : reject(error)));
      });
    }
  });
});
