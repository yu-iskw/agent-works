import { IncomingMessage, ServerResponse } from 'node:http';
import { Socket } from 'node:net';

import { describe, expect, it, vi } from 'vitest';

import { createMemoryAuditLog } from '../audit/write.js';

import { createGovernanceApp } from './runtime.js';
import {
  CREATED,
  governanceFixture,
  readContext,
  recordFixture,
  REQUEST_ID,
  SECRET,
} from './test-fixtures.js';

import type { GovernanceRuntimeDeps } from './runtime.js';
import type { Caller } from '../auth/iap.js';
import type { RequestListener } from 'node:http';

async function app(roles: readonly string[] = ['privacy-officer']) {
  const { port, store, keys } = await governanceFixture();
  await store.put(recordFixture(), SECRET);
  const verify = () => Promise.resolve({ sub: 'alice', assertion: 'verified' } as Caller);
  const now = () => new Date(CREATED);
  const deps: GovernanceRuntimeDeps = {
    app: {
      verify,
      now,
      audit: createMemoryAuditLog(),
      drive: { retrieve: () => Promise.resolve([]) },
      runner: { run: () => Promise.reject(new Error('unused')) },
    },
    registration: { verify, now, governance: { port, rolesFor: () => Promise.resolve(roles) } },
    artifacts: { verify, store, contextFor: () => Promise.resolve(readContext()) },
  };
  return { listener: createGovernanceApp(deps), port, keys };
}

/** Exercise the actual HTTP listener with Node request/response objects, while
 * capturing response.end instead of requiring a local TCP listening capability. */
async function invoke(listener: RequestListener, path: string, method = 'GET', body?: Buffer) {
  const socket = new Socket();
  const request = new IncomingMessage(socket);
  request.url = path;
  request.method = method;
  request.headers = { 'x-role': 'admin' };
  const response = new ServerResponse(request);
  const head = vi.spyOn(response, 'writeHead');
  const finished = new Promise<string>((resolve) => {
    vi.spyOn(response, 'end').mockImplementation((chunk?: unknown) => {
      resolve(typeof chunk === 'string' ? chunk : '');
      return response;
    });
  });
  try {
    listener(request, response);
    if (body !== undefined) request.emit('data', body);
    request.emit('end');
    const payload = await finished;
    return { status: response.statusCode, payload, headers: head.mock.calls };
  } finally {
    socket.destroy();
    vi.restoreAllMocks();
  }
}

describe('governance HTTP boundary without TCP', () => {
  it('decrypts a permitted artifact and serves a deletion intake fence on the next read', async () => {
    const { listener } = await app();
    const before = await invoke(listener, '/v1/artifacts/artifact-1');
    expect(before.status).toBe(200);
    expect(JSON.parse(before.payload)).toEqual({ text: SECRET });
    expect(before.headers).toContainEqual([
      200,
      expect.objectContaining({ 'cache-control': 'no-store' }),
    ]);
    const command = Buffer.from(
      JSON.stringify({ requestId: REQUEST_ID, subject: 'alice', reasonRef: 'privacy' }),
    );
    expect((await invoke(listener, '/v1/admin/governance/deletions', 'POST', command)).status).toBe(
      202,
    );
    expect((await invoke(listener, '/v1/artifacts/artifact-1')).status).toBe(404);
  });

  it('rejects oversized bodies and malformed request targets without uncaught errors', async () => {
    const { listener, port } = await app();
    expect(
      (await invoke(listener, '/v1/admin/governance/deletions', 'POST', Buffer.alloc(16385)))
        .status,
    ).toBe(413);
    const malformed = await invoke(listener, 'http://[');
    expect(malformed.status).toBe(400);
    expect(malformed.headers).toContainEqual([
      400,
      expect.objectContaining({ 'cache-control': 'no-store' }),
    ]);
    expect((await port.snapshot()).requests).toEqual([]);
  });

  it('denies a forged admin header at the composed HTTP boundary', async () => {
    const { listener } = await app(['Employee']);
    const response = await invoke(listener, '/v1/admin/governance/holds');
    expect(response.status).toBe(403);
    expect(response.payload).not.toContain(SECRET);
  });

  it('fails closed after key revocation without returning an envelope', async () => {
    const { listener, keys } = await app();
    keys.revoke('local-key-1');
    const response = await invoke(listener, '/v1/artifacts/artifact-1');
    expect(response.status).toBe(503);
    expect(JSON.parse(response.payload)).toEqual({ error: 'artifact_key_unavailable' });
    expect(response.headers).toContainEqual([
      503,
      expect.objectContaining({ 'cache-control': 'no-store' }),
    ]);
  });
});
