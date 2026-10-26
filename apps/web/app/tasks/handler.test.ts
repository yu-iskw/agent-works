import { once } from 'node:events';

import { IAP_ASSERTION_HEADER } from '@agent-works/domain';
import { expect, test, vi } from 'vitest';

import { createWebServer } from '../../src/server.js';

import type { Server } from 'node:http';

const task = {
  id: 'task-1',
  createdBySub: 'alice-private-canary',
  status: 'COMPLETED',
  objectiveDigest: 'a'.repeat(64),
  skillVersion: 'incident-analysis@1',
  agentVersion: 'agent@1',
  policyVersion: 'policy@1',
  budget: 1,
  version: 1,
  createdAt: '2026-10-10T00:00:00.000Z',
  updatedAt: '2026-10-10T00:01:00.000Z',
};

const apiUrl = 'http://api.example';

async function open(load: typeof fetch): Promise<{ readonly server: Server; readonly url: string }> {
  const server = createWebServer({ apiUrl, fetch: load }).listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('port');
  return { server, url: `http://127.0.0.1:${address.port}` };
}

function close(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => (error === undefined ? resolve() : reject(error)));
  });
}

test('owner sees their task while another user cannot read the same URL or canary', async () => {
  const load = vi.fn<typeof fetch>((_input, init) => {
    const headers = new Headers(init?.headers);
    if (headers.get(IAP_ASSERTION_HEADER) === 'signed-user-a')
      return Promise.resolve(Response.json(task));
    return Promise.resolve(
      Response.json({ error: 'forbidden', leakedCanary: task.createdBySub }, { status: 403 }),
    );
  });
  const { server, url } = await open(load);
  try {
    const path = '/tasks/task-1';
    const owner = await fetch(`${url}${path}?subject=mallory`, {
      headers: {
        [IAP_ASSERTION_HEADER]: 'signed-user-a',
        authorization: 'Bearer mallory',
        cookie: 'session=mallory',
        'x-user-id': 'mallory',
      },
    });
    expect(owner.status).toBe(200);
    expect(owner.headers.get('cache-control')).toBe('no-store');
    expect(owner.headers.get('x-content-type-options')).toBe('nosniff');
    expect(await owner.json()).toEqual(task);

    const other = await fetch(`${url}${path}`, {
      headers: { [IAP_ASSERTION_HEADER]: 'signed-user-b' },
    });
    expect(other.status).toBe(403);
    expect(other.headers.get('cache-control')).toBe('no-store');
    expect(await other.text()).not.toContain(task.createdBySub);
    expect(load).toHaveBeenCalledTimes(2);
    const call = load.mock.calls[0];
    expect(call[0]).toEqual(new URL(`${apiUrl}/v1/tasks/task-1`));
    expect(call[1]).toEqual(
      expect.objectContaining({
        method: 'GET',
        cache: 'no-store',
        redirect: 'manual',
        headers: { [IAP_ASSERTION_HEADER]: 'signed-user-a' },
      }),
    );
  } finally {
    await close(server);
  }
});

test('missing identity and malformed task paths never reach the API', async () => {
  const load = vi.fn<typeof fetch>(() => Promise.resolve(Response.json(task)));
  const { server, url } = await open(load);
  try {
    const withoutIdentity = await fetch(`${url}/tasks/task-1`);
    expect(withoutIdentity.status).toBe(401);
    for (const path of [
      '/tasks/task-1/extra',
      '/tasks/task-1%2Fother',
      '/tasks/%2e%2e%2Fadmin',
      '/tasks/',
    ]) {
      const reply = await fetch(`${url}${path}`, {
        headers: { [IAP_ASSERTION_HEADER]: 'signed-user-a' },
      });
      expect(reply.status).toBe(404);
    }
    const mutating = await fetch(`${url}/tasks/task-1`, {
      method: 'POST',
      headers: { [IAP_ASSERTION_HEADER]: 'signed-user-a' },
    });
    expect(mutating.status).toBe(404);
    expect(load).not.toHaveBeenCalled();
  } finally {
    await close(server);
  }
});

test.each([403, 404])('upstream %s denial never reflects its response body', async (status) => {
  const { server, url } = await open(() =>
    Promise.resolve(Response.json({ private: task.createdBySub }, { status })),
  );
  try {
    const response = await fetch(`${url}/tasks/task-1`, {
      headers: { [IAP_ASSERTION_HEADER]: 'signed-user-b' },
    });
    expect(response.status).toBe(status);
    expect(await response.text()).not.toContain(task.createdBySub);
  } finally {
    await close(server);
  }
});

test.each(['wrong-id', 'invalid-schema', 'redirect', 'unavailable', 'transport'] as const)(
  '%s API failures are fail-closed and redact upstream data',
  async (scenario) => {
    const load: typeof fetch = () => {
      if (scenario === 'transport')
        return Promise.reject(new Error('private upstream credential'));
      if (scenario === 'redirect')
        return Promise.resolve(
          new Response(null, { status: 302, headers: { location: 'https://evil.example' } }),
        );
      if (scenario === 'unavailable')
        return Promise.resolve(new Response(task.createdBySub, { status: 503 }));
      return Promise.resolve(
        Response.json(
          scenario === 'wrong-id'
            ? { ...task, id: 'different-task' }
            : { private: task.createdBySub },
        ),
      );
    };
    const { server, url } = await open(load);
    try {
      const response = await fetch(`${url}/tasks/task-1`, {
        headers: { [IAP_ASSERTION_HEADER]: 'signed-user-a' },
        redirect: 'manual',
      });
      expect(response.status).toBe(
        scenario === 'wrong-id' || scenario === 'invalid-schema' ? 502 : 503,
      );
      expect(response.headers.get('cache-control')).toBe('no-store');
      const body = await response.text();
      expect(body).not.toContain(task.createdBySub);
      expect(body).not.toContain('private upstream credential');
      expect(response.headers.get('location')).toBeNull();
    } finally {
      await close(server);
    }
  },
);
