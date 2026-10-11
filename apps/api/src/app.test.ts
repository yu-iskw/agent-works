import { createServer } from 'node:http';

import { IAP_ASSERTION_HEADER } from '@agent-works/domain';
import { describe, expect, it } from 'vitest';

import { createApp } from './app.js';
import { createMemoryAuditLog } from './audit/write.js';
import { createMemoryApprovalStore, createPostgresApprovalStore } from './broker/approvals.js';
import { createApprovalHarness, useApprovalDatabase } from './broker/broker-harness.js';
import { TICKET_TOOL } from './broker/broker.js';

import type { Caller } from './auth/iap.js';
import type { ApprovalStore } from './broker/approvals.js';
import type { RequestListener } from 'node:http';

const digest = 'a'.repeat(64);
const path = '/v1/approvals/apr-1:decide';
const headers = { [IAP_ASSERTION_HEADER]: 'bob', 'x-csrf-token': 'token-1' };

function app(store: ApprovalStore, env = { AW_APPROVALS: 'real' }) {
  return createApp(
    {
      verify: () => Promise.resolve({ sub: 'bob', assertion: 'bob' } as Caller),
      drive: { retrieve: () => Promise.reject(new Error('unused')) },
      runner: { run: () => Promise.reject(new Error('unused')) },
      audit: createMemoryAuditLog(),
      now: () => new Date(0),
      approvals: { store, rolesFor: () => Promise.resolve(['Reviewer']) },
    },
    env,
  );
}

function decision(expectedPayloadSha256 = digest): string {
  return JSON.stringify({ kind: 'decide', decision: 'approve', expectedPayloadSha256 });
}

async function memoryStore(): Promise<ApprovalStore> {
  const store = createMemoryApprovalStore();
  await store.save({
    id: 'apr-1',
    taskId: 'tsk-1',
    stepId: 'step-1',
    tool: TICKET_TOOL,
    targetResource: 'PROJ',
    payloadSha256: digest,
    requestedBySub: 'alice',
    approverSub: null,
    state: 'pending',
    expiresAt: '2026-12-01T00:00:00.000Z',
    maxExecutions: 1,
    executionsUsed: 0,
  });
  return store;
}

it('round-trips a real decision at the body limit and replays it', async () => {
  const store = await memoryStore();
  const server = await listen(app(store), 0);
  try {
    for (const body of [decision().padEnd(16_384), decision()]) {
      const response = await fetch(`${server.url}${path}`, { method: 'POST', headers, body });
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({
        kind: 'decided',
        id: 'apr-1',
        state: 'approved',
        executionsUsed: 0,
      });
    }
    expect(await store.read('apr-1')).toMatchObject({ state: 'approved', approverSub: 'bob' });
  } finally {
    await server.close();
  }
});

it('rejects pattern bodies over the exact-route limit without deciding', async () => {
  const store = await memoryStore();
  const server = await listen(app(store), 0);
  try {
    const response = await fetch(`${server.url}${path}`, {
      method: 'POST',
      headers,
      body: decision().padEnd(16_385),
    });
    expect(response.status).toBe(413);
    expect(await response.json()).toEqual({ error: 'too_large' });
    expect(await store.read('apr-1')).toMatchObject({ state: 'pending', approverSub: null });
  } finally {
    await server.close();
  }
});

it('keeps approvals stubbed when the real route is disabled', async () => {
  const store = await memoryStore();
  const server = await listen(app(store, { AW_APPROVALS: 'stub' }), 0);
  try {
    const response = await fetch(`${server.url}${path}`, {
      method: 'POST',
      headers,
      body: decision(),
    });
    expect(response.status).toBe(501);
    expect(await store.read('apr-1')).toMatchObject({ state: 'pending', approverSub: null });
  } finally {
    await server.close();
  }
});

describe('Postgres approvals wiring', () => {
  const database = useApprovalDatabase();

  it('updates the durable approval used by the broker through an HTTP decision', async () => {
    const sql = database.sql();
    const harness = await createApprovalHarness(sql);
    const server = await listen(app(createPostgresApprovalStore(sql)), 0);
    try {
      await harness.save(harness.row({ state: 'pending', approverSub: null }));
      const response = await fetch(`${server.url}${path}`, {
        method: 'POST',
        headers,
        body: decision(harness.digest),
      });
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({
        kind: 'decided',
        id: 'apr-1',
        state: 'approved',
        executionsUsed: 0,
      });
      expect(await harness.read('apr-1')).toMatchObject({ state: 'approved', approverSub: 'bob' });
      expect(await harness.execute()).toEqual({ ok: true, receipt: 'FAKE-1', replay: false });
      expect(await harness.read('apr-1')).toMatchObject({ executionsUsed: 1 });
    } finally {
      await server.close();
      await harness.stop();
    }
  });
});

function listen(
  listener: RequestListener,
  port: number,
): Promise<{
  url: string;
  close(): Promise<void>;
}> {
  const server = createServer(listener);
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => {
      const address = server.address();
      if (address === null || typeof address === 'string') {
        reject(new Error('port'));
        return;
      }
      resolve({
        url: `http://127.0.0.1:${address.port}`,
        close: () =>
          new Promise((done, fail) => {
            server.close((error) => (error ? fail(error) : done()));
          }),
      });
    });
  });
}
