import { expect, test, vi } from 'vitest';

import { adminWeb, commandId, emptySnapshot, stopForm } from './test-helpers.js';

const token = 'a'.repeat(64);
const cookie = `aw_admin_csrf=${token}`;
test('confirmation requires authorization and does not mutate until final apply', async () => {
  const calls: { path: string; method: string; body?: string }[] = [];
  const load: typeof fetch = (url, init) => {
    calls.push({
      path: typeof url === 'string' ? url : url instanceof URL ? url.href : url.url,
      method: init?.method ?? 'GET',
      body: init?.body as string | undefined,
    });
    if (init?.method === 'POST')
      return Promise.resolve(
        Response.json({
          replay: false,
          record: {
            target: { scope: 'global', id: '*', version: null },
            suspended: true,
            actorSub: 'admin',
            reason: 'Local stop',
            expiresAt: null,
            revision: 1,
            commandId,
            occurredAt: '2026-10-14T10:00:00.000Z',
          },
        }),
      );
    return Promise.resolve(
      Response.json(
        (typeof url === 'string' ? url : url instanceof URL ? url.href : url.url).endsWith(
          '/history',
        )
          ? { events: [] }
          : emptySnapshot,
      ),
    );
  };
  const app = await adminWeb({ apiUrl: 'http://localhost:8084', fetch: load });
  try {
    const headers = { cookie, 'x-goog-iap-jwt-assertion': 'signed' };
    const confirm = await app.fetch(`${app.url}/admin/confirm`, {
      method: 'POST',
      headers,
      body: stopForm(token),
    });
    expect(confirm.status).toBe(200);
    expect(await confirm.text()).toContain('Confirm change');
    expect(calls.filter((call) => call.method === 'POST')).toEqual([]);
    const form = stopForm(token);
    form.set('confirmed', 'yes');
    const applied = await app.fetch(`${app.url}/admin/apply`, {
      method: 'POST',
      headers,
      body: form,
    });
    expect(applied.status).toBe(200);
    expect(await applied.text()).toContain('Admin change saved.');
    expect(calls.filter((call) => call.method === 'POST')).toHaveLength(1);
    const posted = calls.find((call) => call.method === 'POST');
    expect(JSON.parse(posted?.body ?? '{}')).toEqual({
      commandId,
      action: 'suspend',
      target: { scope: 'global', id: '*', version: null },
      reason: 'Local stop',
      expiresAt: null,
      expectedRevision: 0,
    });
  } finally {
    await app.close();
  }
});
test.each(['/admin/confirm', '/admin/apply'])(
  '%s rejects forged CSRF before backend calls',
  async (path) => {
    const load = vi.fn<typeof fetch>();
    const app = await adminWeb({ apiUrl: 'http://localhost', fetch: load });
    try {
      const response = await app.fetch(`${app.url}${path}`, {
        method: 'POST',
        body: stopForm(token),
      });
      expect(response.status).toBe(403);
      expect(load).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  },
);
test('apply requires a confirmation marker and cannot bypass directory recheck', async () => {
  const load = vi.fn<typeof fetch>().mockResolvedValue(Response.json(emptySnapshot));
  const app = await adminWeb({ apiUrl: 'http://localhost', fetch: load });
  try {
    const response = await app.fetch(`${app.url}/admin/apply`, {
      method: 'POST',
      headers: { cookie },
      body: stopForm(token),
    });
    expect(response.status).toBe(400);
    expect(load).toHaveBeenCalledOnce();
    load.mockResolvedValue(new Response(null, { status: 403 }));
    const form = stopForm(token);
    form.set('confirmed', 'yes');
    expect(
      (
        await app.fetch(`${app.url}/admin/apply`, {
          method: 'POST',
          headers: { cookie },
          body: form,
        })
      ).status,
    ).toBe(403);
    expect(load.mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(0);
  } finally {
    await app.close();
  }
});
test('oversized and invalid form submissions are controlled', async () => {
  const app = await adminWeb({
    apiUrl: 'http://localhost',
    fetch: () => Promise.reject(new Error('should not call')),
  });
  try {
    expect(
      (
        await app.fetch(`${app.url}/admin/confirm`, {
          method: 'POST',
          headers: { cookie },
          body: 'x'.repeat(20_000),
        })
      ).status,
    ).toBe(413);
    expect(
      (
        await app.fetch(`${app.url}/admin/confirm`, {
          method: 'POST',
          headers: { cookie },
          body: new URLSearchParams({ csrfToken: token }),
        })
      ).status,
    ).toBe(400);
  } finally {
    await app.close();
  }
});

test.each([
  ['http://127.0.0.1:8081', 200],
  ['https://evil.example', 403],
])('proxied confirmation from %s returns %s', async (origin, status) => {
  const load = vi.fn<typeof fetch>().mockResolvedValue(Response.json(emptySnapshot));
  const app = await adminWeb({ apiUrl: 'http://api:8080', fetch: load });
  const response = await app.fetch('http://web:8080/admin/confirm', {
    method: 'POST',
    headers: { cookie, origin, 'x-goog-iap-jwt-assertion': 'signed' },
    body: stopForm(token),
  });
  expect(response.status).toBe(status);
  expect(load).toHaveBeenCalledTimes(status === 200 ? 1 : 0);
});
