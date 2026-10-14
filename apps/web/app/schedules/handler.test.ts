import { expect, test, vi } from 'vitest';

import { openSchedulesServer, scheduleWebRecord } from './test-fixtures.js';
const json = (body: unknown, status = 200) => Promise.resolve(Response.json(body, { status }));
test('GET forwards only the verified assertion and renders list with CSRF cookie', async () => {
  const load = vi.fn<typeof fetch>(() => json({ schedules: [scheduleWebRecord()] }));
  const server = await openSchedulesServer(load);
  try {
    const reply = await server.fetch(`${server.url}/schedules`, {
      headers: { 'x-goog-iap-jwt-assertion': 'assertion' },
    });
    expect(reply.status).toBe(200);
    expect(await reply.text()).toContain('Scheduled tasks');
    expect(reply.headers.get('set-cookie')).toContain('HttpOnly; SameSite=Strict');
    expect(load.mock.calls[0][1]?.headers).toMatchObject({
      'x-goog-iap-jwt-assertion': 'assertion',
    });
    expect(reply.headers.get('cache-control')).toBe('no-store');
  } finally {
    await server.close();
  }
});
test.each(['/schedules/preview', '/schedules/create', '/schedules/change'])(
  '%s rejects missing CSRF before contacting API',
  async (path) => {
    const load = vi.fn<typeof fetch>(() => json({ schedules: [] }));
    const server = await openSchedulesServer(load);
    try {
      const reply = await server.fetch(`${server.url}${path}`, {
        method: 'POST',
        body: new URLSearchParams({ spec: '{}' }),
      });
      expect(reply.status).toBe(403);
      expect(load).not.toHaveBeenCalled();
    } finally {
      await server.close();
    }
  },
);
test('privilege preview followed by creation and pause/resume uses authenticated API', async () => {
  const row = scheduleWebRecord();
  const load = vi.fn<typeof fetch>((input) => {
    const path = new URL(input instanceof Request ? input.url : input.toString()).pathname;
    return json(
      path === '/v1/schedules'
        ? { schedules: [row] }
        : path === '/v1/schedules/preview'
          ? { allowed: true }
          : row,
    );
  });
  const server = await openSchedulesServer(load);
  try {
    const page = await server.fetch(`${server.url}/schedules`);
    const cookie = page.headers.get('set-cookie')!.split(';')[0];
    const token = cookie.split('=')[1];
    const headers = { cookie, origin: server.url, 'x-goog-iap-jwt-assertion': 'assertion' };
    const form = new URLSearchParams({ csrfToken: token, spec: JSON.stringify(row.spec) });
    const preview = await server.fetch(`${server.url}/schedules/preview`, {
      method: 'POST',
      headers,
      body: form,
    });
    expect(preview.status).toBe(200);
    expect(await preview.text()).toContain('Schedule privilege preview');
    const created = await server.fetch(`${server.url}/schedules/create`, {
      method: 'POST',
      headers,
      body: form,
    });
    expect(created.status).toBe(200);
    expect(await created.text()).toContain('Schedule created.');
    for (const action of ['pause', 'resume']) {
      const reply = await server.fetch(`${server.url}/schedules/change`, {
        method: 'POST',
        headers,
        body: new URLSearchParams({ csrfToken: token, id: row.spec.id, revision: '1', action }),
      });
      expect(reply.status).toBe(200);
      expect(await reply.text()).toContain('Schedule updated.');
    }
  } finally {
    await server.close();
  }
});
test('cross-origin mutation fails CSRF even with matching double-submit token', async () => {
  const load = vi.fn<typeof fetch>(() => json({ schedules: [] }));
  const server = await openSchedulesServer(load);
  try {
    const token = 'a'.repeat(64);
    const reply = await server.fetch(`${server.url}/schedules/create`, {
      method: 'POST',
      headers: { cookie: `aw_schedules_csrf=${token}`, origin: 'https://evil.example' },
      body: new URLSearchParams({ csrfToken: token }),
    });
    expect(reply.status).toBe(403);
    expect(load).not.toHaveBeenCalled();
  } finally {
    await server.close();
  }
});
test('API unavailable and forbidden states remain visible to the user', async () => {
  for (const status of [403, 503]) {
    const server = await openSchedulesServer(() => json({ error: 'unavailable' }, status));
    try {
      const reply = await server.fetch(`${server.url}/schedules`);
      expect(reply.status).toBe(status);
      expect(await reply.text()).toContain('Schedules are unavailable');
    } finally {
      await server.close();
    }
  }
});
test('invalid and oversized forms never mutate API', async () => {
  const load = vi.fn<typeof fetch>(() => json({ schedules: [] }));
  const server = await openSchedulesServer(load);
  try {
    const token = 'a'.repeat(64);
    const headers = { cookie: `aw_schedules_csrf=${token}` };
    const reply = await server.fetch(`${server.url}/schedules/create`, {
      method: 'POST',
      headers,
      body: new URLSearchParams({ csrfToken: token, spec: 'not-json' }),
    });
    expect(reply.status).toBe(400);
    const oversized = await server.fetch(`${server.url}/schedules/create`, {
      method: 'POST',
      headers,
      body: 'x'.repeat(40000),
    });
    expect(oversized.status).toBe(413);
    expect(load).not.toHaveBeenCalled();
  } finally {
    await server.close();
  }
});
