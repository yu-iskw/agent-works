import { IAP_ASSERTION_HEADER } from '@agent-works/domain';
import { describe, expect, it } from 'vitest';

import { Unauthenticated } from '../auth/iap.js';
import { governedArtifactReadRoute } from '../governance/artifact-route.js';
import {
  governanceFixture,
  readContext,
  recordFixture,
  SECRET,
} from '../governance/test-fixtures.js';
import { createMemoryTaskPorts } from '../ports/memory/task-ports.js';
import { createSkillRegistry } from '../skills/registry.js';
import { taskAuthorization } from '../testing/task-authorization.js';

import { createTaskRoutes } from './tasks.js';

import type { Caller, VerifyAssertion } from '../auth/iap.js';
import type { Route } from '../http.js';

const verify: VerifyAssertion = (assertion) => {
  if (assertion === 'alice-token') return Promise.resolve({ sub: 'alice' } as Caller);
  if (assertion === 'bob-token') return Promise.resolve({ sub: 'bob' } as Caller);
  return Promise.reject(new Unauthenticated('bad_signature'));
};

function get(path: string, token?: string): Parameters<Route>[0] {
  return {
    method: 'GET',
    path,
    headers: token === undefined ? {} : { [IAP_ASSERTION_HEADER]: token },
    body: Buffer.alloc(0),
  };
}

async function seededTasks() {
  const ports = createMemoryTaskPorts();
  const routes = createTaskRoutes(
    ports.ledger,
    verify,
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
  const created = await routes.submit({
    method: 'POST',
    path: '/v1/tasks',
    headers: { [IAP_ASSERTION_HEADER]: 'alice-token', 'idempotency-key': 'k-1' },
    body: Buffer.from(
      JSON.stringify({
        kind: 'submit',
        objective: 'alice private objective',
        skillId: 'ask',
        sourceAllowlist: ['drive'],
        requestedOutputs: ['answer'],
        executionPolicy: { mode: 'interactive', budgetUsd: 0.1, deadlineSeconds: 30 },
      }),
    ),
  });
  const taskId = (created.body as { taskId: string }).taskId;
  return { routes, taskId };
}

describe('task read isolation', () => {
  it('serves the owner and denies another user, an outsider and forged ids identically', async () => {
    const { routes, taskId } = await seededTasks();
    const path = `/v1/tasks/${taskId}`;
    const owner = await routes.read(get(path, 'alice-token'));
    expect(owner.status).toBe(200);
    expect((owner.body as { id: string }).id).toBe(taskId);

    const missing = await routes.read(get('/v1/tasks/does-not-exist', 'alice-token'));
    const other = await routes.read(get(path, 'bob-token'));
    expect(other).toEqual(missing);
    expect(other).toEqual({ status: 404, body: { error: 'not_found' } });
    expect(await routes.read(get(path, 'forged-token'))).toEqual({
      status: 401,
      body: { error: 'unauthenticated' },
    });
    expect((await routes.read(get(path))).status).toBe(401);
  });

  it('exposes no event, list or traversal path to a non-owner', async () => {
    const { routes, taskId } = await seededTasks();
    expect((await routes.events(get(`/v1/tasks/${taskId}/events`, 'bob-token'))).status).toBe(404);
    for (const path of ['/v1/tasks', '/v1/tasks/', `/v1/tasks/${taskId}/other`]) {
      expect((await routes.read(get(path, 'bob-token'))).status).toBe(404);
    }
  });
});

describe('artifact read isolation', () => {
  async function route(contextSubject: (sub: string) => string = (sub) => sub) {
    const { store } = await governanceFixture();
    await store.put(recordFixture('artifact-1', 'alice'), SECRET);
    return governedArtifactReadRoute({
      verify,
      store,
      contextFor: (sub) => Promise.resolve(readContext(contextSubject(sub))),
    });
  }

  it('serves the owner and returns the same 404 for another user, random ids and bad refs', async () => {
    const read = await route();
    expect(await read(get('/v1/artifacts/artifact-1', 'alice-token'))).toEqual({
      status: 200,
      body: { text: SECRET },
    });
    const absent = await read(get('/v1/artifacts/artifact-zzz', 'alice-token'));
    const other = await read(get('/v1/artifacts/artifact-1', 'bob-token'));
    expect(other).toEqual(absent);
    expect(other).toEqual({ status: 404, body: { error: 'not_found' } });
    expect(JSON.stringify(other)).not.toContain(SECRET);
    expect((await read(get('/v1/artifacts/artifact-1/extra', 'alice-token'))).status).toBe(404);
    expect((await read(get('/v1/artifacts', 'alice-token'))).status).toBe(404);
  });

  it('rejects unauthenticated callers and a context minted for a different subject', async () => {
    const read = await route();
    expect((await read(get('/v1/artifacts/artifact-1'))).status).toBe(401);
    expect((await read(get('/v1/artifacts/artifact-1', 'forged-token'))).status).toBe(401);
    const forged = await route(() => 'alice');
    const reply = await forged(get('/v1/artifacts/artifact-1', 'bob-token'));
    expect(reply).toEqual({ status: 403, body: { error: 'forbidden' } });
    expect(JSON.stringify(reply)).not.toContain(SECRET);
  });
});
