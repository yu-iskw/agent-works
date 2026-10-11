import { createServer } from 'node:http';
import { connect } from 'node:net';

import { describe, expect, it } from 'vitest';

import { createApp } from '../app.js';
import { createMemoryAuditLog } from '../audit/write.js';
import { Unauthenticated } from '../auth/iap.js';

import { notImplementedReply } from './not-implemented.js';
import { searchSlot } from './search.js';
import { selectRoute } from './slot.js';

import { createRouteTable, matchSlot } from './index.js';

import type { Route } from '../http.js';
import type { AskDeps } from './ask.js';
import type { Server } from 'node:http';

const deps: AskDeps = {
  verify: () => Promise.reject(new Unauthenticated('missing')),
  drive: { retrieve: () => Promise.reject(new Error('unused')) },
  runner: { run: () => Promise.reject(new Error('unused')) },
  audit: createMemoryAuditLog(),
  now: () => new Date(0),
};

describe('route registry', () => {
  it('keeps ask on the real route and stubs the new exact routes', async () => {
    const table = createRouteTable(deps, {});
    const skills = table['GET /v1/skills'];
    expect(
      await skills({ method: 'GET', path: '/v1/skills', headers: {}, body: Buffer.alloc(0) }),
    ).toEqual(notImplementedReply);
    const real: Route = () => Promise.resolve({ status: 204, body: '' });
    expect(selectRoute({ ...searchSlot, real }, { AW_SEARCH: 'real' })).toBe(real);
    expect(selectRoute(searchSlot, { AW_SEARCH: 'real' })).toBe(searchSlot.stub);
    expect(selectRoute(searchSlot, {})).toBe(searchSlot.stub);
  });

  it('matches parameterized routes to their own modules', () => {
    expect(matchSlot('GET', '/v1/tasks/abc/events')?.id).toBe('tasks-events');
    expect(matchSlot('GET', '/v1/tasks/abc')?.id).toBe('tasks-read');
    expect(matchSlot('POST', '/v1/tasks/abc:cancel')?.id).toBe('tasks-cancel');
    expect(matchSlot('GET', '/v1/approvals/id')?.id).toBe('approvals-read');
    expect(matchSlot('POST', '/v1/approvals/id:decide')?.id).toBe('approvals-decide');
    expect(matchSlot('GET', '/v1/artifacts/id')?.id).toBe('artifacts-read');
    expect(matchSlot('POST', '/v1/oauth/connections/google')?.id).toBe('oauth-connect');
    expect(matchSlot('DELETE', '/v1/oauth/connections/google')?.id).toBe('oauth-revoke');
    expect(matchSlot('POST', '/v1/tasks')).toBeUndefined();
    expect(matchSlot('GET', '/healthz')).toBeUndefined();
  });

  it('serves health, ask, exact stubs, and pattern stubs', async () => {
    const server = createServer(createApp(deps, {}));
    const port = await listen(server);
    try {
      expect(await status(port, '/healthz')).toEqual({ status: 200, body: 'ok' });
      expect(await status(port, '/v1/ask', 'POST', '{}')).toEqual({
        status: 401,
        body: { error: 'unauthenticated' },
      });
      expect(await status(port, '/v1/skills')).toEqual({
        status: 501,
        body: { error: 'not_implemented' },
      });
      expect(await status(port, '/v1/tasks/abc')).toEqual({
        status: 501,
        body: { error: 'not_implemented' },
      });
      expect(await status(port, '/missing')).toEqual({ status: 404, body: { error: 'not_found' } });
      const crashed = await raw(
        port,
        'GET // HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n',
      );
      expect(crashed.startsWith('HTTP/1.1 500')).toBe(true);
      expect(await status(port, '/healthz')).toEqual({ status: 200, body: 'ok' });
    } finally {
      await close(server);
    }
  });
});

function raw(port: number, payload: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = connect(port, '127.0.0.1', () => {
      socket.write(payload);
    });
    const chunks: Buffer[] = [];
    socket.on('data', (chunk: Buffer) => chunks.push(chunk));
    socket.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    socket.on('error', reject);
  });
}

function listen(server: Server): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (address === null || typeof address === 'string') {
        reject(new Error('port'));
        return;
      }
      resolve(address.port);
    });
  });
}

function close(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

async function status(
  port: number,
  path: string,
  method = 'GET',
  body?: string,
): Promise<{ status: number; body: unknown }> {
  const response = await fetch(`http://127.0.0.1:${port}${path}`, { method, body });
  const text = await response.text();
  const parsed: unknown = text.startsWith('{') ? JSON.parse(text) : text;
  return { status: response.status, body: parsed };
}
