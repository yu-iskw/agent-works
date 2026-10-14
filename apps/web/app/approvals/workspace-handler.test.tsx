import { Readable } from 'node:stream';

import { canonicalPayloadSha256 } from '@agent-works/domain';
import { describe, expect, it } from 'vitest';

import { createWebServer } from '../../src/server.js';

import { createWorkspaceApprovalsHandler } from './workspace-handler.js';

import type { Approval } from '@agent-works/domain';
import type { IncomingMessage, ServerResponse } from 'node:http';
const payload = {
  title: 'Meeting prep',
  destinationId: 'alice-folder',
  body: '<script>bad()</script>Agenda',
};
const row: Approval = {
  id: 'approval-1',
  taskId: 'task-1',
  stepId: 'docs',
  tool: 'docs.createDraft@1.0.0',
  targetResource: 'alice-folder',
  payloadSha256: canonicalPayloadSha256(payload),
  requestedBySub: 'alice',
  approverSub: null,
  state: 'pending',
  expiresAt: '2027-01-01T00:00:00Z',
  maxExecutions: 1,
  executionsUsed: 0,
};
const now = new Date('2026-10-14T10:00:00Z');
function harness(
  patch: Partial<Approval> = {},
  changedPayload: unknown = payload,
  mounted = false,
) {
  const calls: { path: string; body: unknown; headers: Headers }[] = [];
  const load: typeof fetch = (url, options) => {
    const path = new URL(url instanceof Request ? url.url : url.toString()).pathname;
    calls.push({
      path,
      body: JSON.parse(typeof options?.body === 'string' ? options.body : '{}') as unknown,
      headers: new Headers(options?.headers),
    });
    return Promise.resolve(
      Response.json(
        path.endsWith('/decide')
          ? { id: row.id, state: 'approved', executionsUsed: 0 }
          : { approval: { ...row, ...patch }, payload: changedPayload },
      ),
    );
  };
  const handler = createWorkspaceApprovalsHandler({
    apiUrl: 'http://127.0.0.1:8084',
    fetch: load,
    now: () => now,
  });
  function request(
    method = 'GET',
    body = '',
    headers: Record<string, string> = {},
    url = '/approvals/workspace/approval-1',
  ) {
    const input = Object.assign(Readable.from([Buffer.from(body)]), {
      method,
      url,
      headers: { host: '127.0.0.1:8085', 'x-goog-iap-jwt-assertion': 'caller-token', ...headers },
    }) as unknown as IncomingMessage;
    let status = 0;
    const responseHeaders = new Map<string, string>();
    return new Promise<{ status: number; body: string; headers: ReadonlyMap<string, string> }>(
      (resolve) => {
        const output = {
          headersSent: false,
          setHeader: (name: string, value: string) => {
            responseHeaders.set(name, value);
          },
          writeHead: (code: number, values: Record<string, string>) => {
            status = code;
            for (const [key, value] of Object.entries(values)) responseHeaders.set(key, value);
          },
          end: (text: string) => resolve({ status, body: text, headers: responseHeaders }),
        } as unknown as ServerResponse;
        if (mounted)
          createWebServer({ apiUrl: 'http://127.0.0.1:8084', fetch: load }).emit(
            'request',
            input,
            output,
          );
        else handler(input, output);
      },
    );
  }
  return { request, calls };
}
describe('workspace approval web handler', () => {
  it('requires an explicit allowlist for the Compose API hostname', () => {
    expect(() => createWorkspaceApprovalsHandler({ apiUrl: 'http://api:8080' })).toThrow(
      'offline endpoint',
    );
    expect(() =>
      createWorkspaceApprovalsHandler({ apiUrl: 'http://api:8080', allowedApiHosts: ['api'] }),
    ).not.toThrow();
  });
  it('mounts the workspace approval page in the dev web server', async () => {
    const result = await harness({}, payload, true).request();
    expect(result.status).toBe(200);
    expect(result.body).toContain('alice-folder');
    expect(result.body).toContain('csrfToken');
  });
  it('loads an authorized exact payload and renders escaped diff plus CSRF controls', async () => {
    const h = harness();
    const result = await h.request();
    expect(result.status).toBe(200);
    expect(result.body).toContain('alice-folder');
    expect(result.body).toContain('&lt;script&gt;');
    expect(result.body).not.toContain('<script>bad');
    expect(result.body).toContain(row.payloadSha256);
    expect(result.headers.get('set-cookie')).toContain('HttpOnly; SameSite=Strict');
    expect(h.calls[0].headers.get('x-goog-iap-jwt-assertion')).toBe('caller-token');
  });
  it('requires matching CSRF cookie before posting a decision', async () => {
    const h = harness();
    const result = await h.request(
      'POST',
      'decision=approve',
      {},
      '/approvals/workspace/approval-1/decide',
    );
    expect(result.status).toBe(403);
    expect(h.calls).toHaveLength(1);
  });
  it('rejects foreign Origin even when tokens match', async () => {
    const h = harness();
    const token = 'a'.repeat(64);
    const body = new URLSearchParams({
      decision: 'approve',
      csrfToken: token,
      expectedPayloadSha256: row.payloadSha256,
    });
    const result = await h.request(
      'POST',
      body.toString(),
      { cookie: `workspace-approval-csrf=${token}`, origin: 'http://attacker.test' },
      '/approvals/workspace/approval-1/decide',
    );
    expect(result.status).toBe(403);
    expect(h.calls).toHaveLength(1);
  });
  it('rejects edited hidden digest before posting a decision', async () => {
    const h = harness();
    const token = 'a'.repeat(64);
    const body = new URLSearchParams({
      decision: 'approve',
      csrfToken: token,
      expectedPayloadSha256: '0'.repeat(64),
    });
    const result = await h.request(
      'POST',
      body.toString(),
      { cookie: `workspace-approval-csrf=${token}`, origin: 'http://127.0.0.1:8085' },
      '/approvals/workspace/approval-1/decide',
    );
    expect(result.status).toBe(409);
    expect(h.calls).toHaveLength(1);
  });
  it('posts the exact approved digest and replaces decision controls with a saved status', async () => {
    const h = harness();
    const token = 'a'.repeat(64);
    const body = new URLSearchParams({
      decision: 'approve',
      csrfToken: token,
      expectedPayloadSha256: row.payloadSha256,
    });
    const result = await h.request(
      'POST',
      body.toString(),
      { cookie: `workspace-approval-csrf=${token}`, origin: 'http://127.0.0.1:8085' },
      '/approvals/workspace/approval-1/decide',
    );
    expect(result.status).toBe(200);
    expect(result.body).toContain('Decision saved.');
    expect(result.body).not.toContain('<button');
    expect(h.calls[1].body).toEqual({
      approvalId: row.id,
      decision: 'approve',
      expectedPayloadSha256: row.payloadSha256,
    });
  });
  it('refuses to render a payload whose digest does not match', async () => {
    const h = harness({}, { ...payload, body: 'edited' });
    const result = await h.request();
    expect(result.status).toBe(503);
    expect(result.body).not.toContain('edited');
    expect(result.body).not.toContain('<button');
  });
  it('hides decision controls on expired approvals', async () => {
    const result = await harness({ expiresAt: '2026-01-01T00:00:00Z' }).request();
    expect(result.status).toBe(200);
    expect(result.body).toContain('This approval has expired.');
    expect(result.body).not.toContain('<button');
  });
  it('does not accept unrelated paths', async () => {
    const h = harness();
    expect((await h.request('GET', '', {}, '/approvals/other')).status).toBe(404);
    expect(h.calls).toEqual([]);
  });
});
