import { Readable } from 'node:stream';

import { describe, expect, it, vi } from 'vitest';

import { createMemoryWebApp } from './runtime.js';
import { webMemoryConsent, webMemoryItem } from './test-fixtures.js';

import type { IncomingMessage, ServerResponse } from 'node:http';
type Reply = { status: number; headers: Record<string, unknown>; body: string };
function invoke(
  load: typeof fetch,
  method = 'GET',
  path = '/memory',
  body = '',
  headers: IncomingMessage['headers'] = {},
): Promise<Reply> {
  const request = Object.assign(Readable.from([Buffer.from(body)]), {
    method,
    url: path,
    headers: { host: 'web.local', ...headers },
  }) as IncomingMessage;
  return new Promise((resolve) => {
    const reply: Reply = { status: 0, headers: {}, body: '' };
    const response = {
      headersSent: false,
      setHeader(name: string, value: unknown) {
        Object.assign(reply.headers, { [name]: value });
      },
      writeHead(status: number, values: Record<string, unknown>) {
        reply.status = status;
        Object.assign(reply.headers, values);
      },
      end(value: string) {
        reply.body = value;
        resolve(reply);
      },
    } as unknown as ServerResponse;
    createMemoryWebApp({ apiUrl: 'http://api.local', fetch: load })(request, response);
  });
}

const token = 'a'.repeat(64);
const headers = {
  cookie: `aw_memory_csrf=${token}`,
  origin: 'http://web.local',
  'x-goog-iap-jwt-assertion': 'verified',
};
function service(input: Parameters<typeof fetch>[0]): Promise<Response> {
  const path = new URL(input instanceof Request ? input.url : input.toString()).pathname;
  return Promise.resolve(
    Response.json(
      path === '/v1/memory/consent'
        ? { consent: webMemoryConsent, notice: 'Optional memory', tenantEnabled: true }
        : { items: [webMemoryItem()] },
    ),
  );
}
function form(values: Record<string, string> = {}) {
  return new URLSearchParams({ csrfToken: token, ...values }).toString();
}
describe('direct memory HTTP handler', () => {
  it('serves an escaped private page and scoped CSRF cookie', async () => {
    const load = vi.fn<typeof fetch>(service);
    const reply = await invoke(load, 'GET', '/memory', '', headers);
    expect(reply.status).toBe(200);
    expect(reply.body).toContain('Your memory');
    expect(reply.headers).toMatchObject({
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
    });
    expect(reply.headers['set-cookie']).toContain('Path=/memory; HttpOnly; SameSite=Strict');
    expect(reply.headers['content-security-policy']).toContain("frame-ancestors 'none'");
    expect(load).toHaveBeenCalledTimes(2);
  });
  it('forwards only the trusted IAP assertion', async () => {
    const load = vi.fn<typeof fetch>(service);
    await invoke(load, 'GET', '/memory', '', { ...headers, 'x-user-sub': 'bob' });
    for (const call of load.mock.calls) {
      expect(call[1]?.headers).toMatchObject({ 'x-goog-iap-jwt-assertion': 'verified' });
      expect(call[1]?.headers).not.toHaveProperty('x-user-sub');
      expect(call[1]?.redirect).toBe('error');
    }
  });
  it.each(['/memory/consent', '/memory/edit', '/memory/delete'])(
    'rejects mutation %s without CSRF before backend access',
    async (path) => {
      const load = vi.fn<typeof fetch>(service);
      expect((await invoke(load, 'POST', path, form())).status).toBe(403);
      expect(load).not.toHaveBeenCalled();
    },
  );
  it.each(['http://evil.local', 'null', 'invalid'])('rejects cross-origin %s', async (origin) => {
    const load = vi.fn<typeof fetch>(service);
    expect(
      (
        await invoke(load, 'POST', '/memory/consent', form({ enabled: 'false', revision: '1' }), {
          ...headers,
          origin,
        })
      ).status,
    ).toBe(403);
    expect(load).not.toHaveBeenCalled();
  });
  it('accepts matching consent token and sends notice version and revision', async () => {
    const load = vi.fn<typeof fetch>(service);
    const reply = await invoke(
      load,
      'POST',
      '/memory/consent',
      form({ enabled: 'false', revision: '1' }),
      headers,
    );
    expect(reply.status).toBe(200);
    expect(reply.body).toContain('Memory updated.');
    expect(load.mock.calls[0][1]?.body).toBe(
      JSON.stringify({ enabled: false, revision: 1, noticeVersion: 'memory-v1' }),
    );
  });
  it('sends own edit and delete commands without claimed subject', async () => {
    const item = webMemoryItem();
    for (const action of ['edit', 'delete']) {
      const load = vi.fn<typeof fetch>(service);
      const reply = await invoke(
        load,
        'POST',
        `/memory/${action}`,
        form({ id: item.id, agent: item.agent, revision: '1', text: 'Updated', owner: 'bob' }),
        headers,
      );
      expect(reply.status).toBe(200);
      const command = JSON.parse(load.mock.calls[0][1]?.body as string) as Record<string, unknown>;
      expect(command).not.toHaveProperty('owner');
      expect(command).toMatchObject({ id: item.id, agent: 'default', revision: 1 });
    }
  });
  it('rejects large forms and malformed revisions without API writes', async () => {
    const load = vi.fn<typeof fetch>(service);
    expect((await invoke(load, 'POST', '/memory/edit', 'x'.repeat(16385), headers)).status).toBe(
      413,
    );
    expect(
      (
        await invoke(
          load,
          'POST',
          '/memory/edit',
          form({ id: webMemoryItem().id, agent: 'default', revision: 'bad', text: 'x' }),
          headers,
        )
      ).status,
    ).toBe(400);
    expect(load).not.toHaveBeenCalled();
  });
  it('exports private JSON with no-store', async () => {
    const load = vi.fn<typeof fetch>(service);
    const reply = await invoke(load, 'GET', '/memory/export', '', headers);
    expect(reply.status).toBe(200);
    expect(reply.headers['content-type']).toBe('application/json');
    expect(reply.headers['cache-control']).toBe('no-store');
    expect(JSON.parse(reply.body)).toMatchObject({ items: [{ owner: 'alice' }] });
  });
  it('returns a safe unavailable message on backend failure', async () => {
    const load = vi.fn<typeof fetch>(() =>
      Promise.resolve(Response.json({ error: 'SECRET' }, { status: 403 })),
    );
    const reply = await invoke(load);
    expect(reply.status).toBe(503);
    expect(reply.body).not.toContain('SECRET');
  });
  it('rejects unknown paths and unsupported methods', async () => {
    const load = vi.fn<typeof fetch>(service);
    expect((await invoke(load, 'GET', '/memory/unknown')).status).toBe(404);
    expect((await invoke(load, 'DELETE', '/memory')).status).toBe(404);
    expect(load).not.toHaveBeenCalled();
  });
});
