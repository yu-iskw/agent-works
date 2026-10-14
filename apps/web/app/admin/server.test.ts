import { expect, test } from 'vitest';

import { createWebServer } from '../../src/server.js';

import { serverFetch } from './test-helpers.js';

test('existing web server serves admin with restrictive headers and retains Ask', async () => {
  const server = createWebServer({
    apiUrl: 'http://localhost',
    fetch: (url) =>
      Promise.resolve(
        Response.json(
          (typeof url === 'string' ? url : url instanceof URL ? url.href : url.url).endsWith(
            '/history',
          )
            ? { events: [] }
            : { suspensions: [], versions: [] },
        ),
      ),
  });
  const url = 'http://127.0.0.1:8085';
  const fetch = serverFetch(server);
  try {
    const response = await fetch(`${url}/admin`, {
      headers: { 'x-goog-iap-jwt-assertion': 'signed' },
    });
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(response.headers.get('content-security-policy')).toContain("frame-ancestors 'none'");
    expect(response.headers.get('set-cookie')).toContain('HttpOnly');
    expect(await response.text()).toContain('Audit trail');
    expect((await fetch(`${url}/`)).status).toBe(200);
    expect((await fetch(`${url}/healthz`)).status).toBe(200);
    expect((await fetch(`${url}/admin/unknown`)).status).toBe(404);
  } finally {
    server.close();
  }
});
test.each([401, 403, 503])(
  'admin server preserves status %s and exposes no mutation form',
  async (status) => {
    const server = createWebServer({
      apiUrl: 'http://localhost',
      fetch: () => Promise.resolve(new Response(null, { status })),
    });
    const url = 'http://127.0.0.1:8085';
    const fetch = serverFetch(server);
    try {
      const response = await fetch(`${url}/admin`);
      expect(response.status).toBe(status);
      expect(await response.text()).not.toContain('<form');
    } finally {
      server.close();
    }
  },
);
