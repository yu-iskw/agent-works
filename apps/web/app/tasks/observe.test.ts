import { once } from 'node:events';
import { createServer } from 'node:http';

import { IAP_ASSERTION_HEADER } from '@agent-works/domain';
import { expect, test, vi } from 'vitest';

import { createOwnerReadHandler } from './handler.js';

import type { Server } from 'node:http';

async function open(
  observe: Parameters<typeof createOwnerReadHandler>[0]['observe'],
  load: typeof fetch,
) {
  const server: Server = createServer(
    createOwnerReadHandler({ apiUrl: 'http://api.example', fetch: load, observe }),
  ).listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('port');
  return { server, url: `http://127.0.0.1:${address.port}` };
}

const traceparent = '00-00112233445546778899aabbccddeeff-aabbccddeeff0011-01';

test('owner read reports kind, status and trace but no id or assertion, and forwards the trace', async () => {
  const load = vi.fn<typeof fetch>(() => Promise.resolve(Response.json({}, { status: 404 })));
  const events: unknown[] = [];
  const { server, url } = await open((event) => events.push(event), load);
  try {
    const reply = await fetch(`${url}/tasks/secret-task-id`, {
      headers: { [IAP_ASSERTION_HEADER]: 'assertion-canary', traceparent },
    });
    expect(reply.status).toBe(404);
    await vi.waitFor(() => expect(events).toHaveLength(1));
    expect(events[0]).toEqual({ kind: 'tasks', status: 404, traceparent });
    expect(JSON.stringify(events)).not.toMatch(/secret-task-id|assertion-canary/);
    expect(new Headers(load.mock.calls[0][1]?.headers).get('traceparent')).toBe(traceparent);
  } finally {
    server.close();
  }
});

test('a throwing observer cannot change the owner-scoped denial', async () => {
  const load = vi.fn<typeof fetch>(() => Promise.resolve(Response.json({}, { status: 403 })));
  const observe = vi.fn(() => {
    throw new Error('exporter down');
  });
  const { server, url } = await open(observe, load);
  try {
    const reply = await fetch(`${url}/tasks/task-1`, { headers: { [IAP_ASSERTION_HEADER]: 'a' } });
    expect(reply.status).toBe(403);
    expect(await reply.text()).toBe('not found');
    await vi.waitFor(() => expect(observe).toHaveBeenCalled());
  } finally {
    server.close();
  }
});
