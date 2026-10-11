import { createServer } from 'node:http';

import { expect, test } from 'vitest';

import { createWebServer } from '../../src/server.js';

import type { Server } from 'node:http';

const detail = {
  kind: 'detail',
  id: 'apr-1',
  actionSummary: 'tickets.create on PROJ <draft>',
  requestedBySub: 'alice',
  payloadSha256: 'a'.repeat(64),
  state: 'pending',
  expiresAt: '2099-12-01T00:00:00.000Z',
};

test('the real web server reads and decides approvals with the caller identity', async () => {
  const calls: { method?: string; url?: string; assertion?: string | string[] }[] = [];
  const api = createServer((request, response) => {
    calls.push({
      method: request.method,
      url: request.url,
      assertion: request.headers['x-goog-iap-jwt-assertion'],
    });
    response.setHeader('content-type', 'application/json');
    response.end(
      JSON.stringify(
        request.method === 'GET'
          ? detail
          : {
              kind: 'decided',
              id: detail.id,
              state: 'approved',
              executionsUsed: 0,
            },
      ),
    );
  });
  const apiUrl = await listen(api);
  const web = createWebServer({ apiUrl });
  try {
    const url = await listen(web);
    const headers = { 'x-goog-iap-jwt-assertion': 'test-reviewer' };
    const page = await fetch(`${url}/approvals/apr-1`, { headers });
    expect(page.status).toBe(200);
    expect(page.headers.get('cache-control')).toBe('no-store');
    const html = await page.text();
    expect(html).toContain('tickets.create on PROJ &lt;draft&gt;');
    expect(html).toContain(detail.payloadSha256);
    expect(html).toContain('Approve');
    const cookie = page.headers.get('set-cookie')?.split(';')[0] ?? '';
    const decision = await fetch(`${url}/approvals/apr-1/decide`, {
      method: 'POST',
      headers: { ...headers, cookie },
      body: new URLSearchParams({
        csrfToken: cookie.split('=')[1],
        decision: 'approve',
        expectedPayloadSha256: detail.payloadSha256,
      }),
    });
    expect(decision.status).toBe(200);
    expect(await decision.text()).toContain('Approval approved.');
    expect(calls).toEqual([
      { method: 'GET', url: '/v1/approvals/apr-1', assertion: 'test-reviewer' },
      { method: 'GET', url: '/v1/approvals/apr-1', assertion: 'test-reviewer' },
      { method: 'POST', url: '/v1/approvals/apr-1:decide', assertion: 'test-reviewer' },
    ]);
    expect((await fetch(`${url}/healthz`)).status).toBe(200);
    expect((await fetch(`${url}/`)).status).toBe(200);
    expect((await fetch(`${url}/unknown`)).status).toBe(404);
  } finally {
    await close(web);
    await close(api);
  }
});

test.each(['missing', 'unavailable', 'invalid', 'wrong-id'])(
  'the real web server handles %s approval reads',
  async (scenario) => {
    const web = createWebServer({
      apiUrl: 'http://127.0.0.1:9',
      fetch: () =>
        Promise.resolve(
          scenario === 'missing'
            ? new Response(null, { status: 404 })
            : scenario === 'unavailable'
              ? new Response(null, { status: 503 })
              : scenario === 'invalid'
                ? Response.json({ kind: 'decided' })
                : Response.json({ ...detail, id: 'other' }),
        ),
    });
    try {
      const url = await listen(web);
      const page = await fetch(`${url}/approvals/apr-1`);
      expect(page.status).toBe(scenario === 'missing' ? 404 : 503);
      expect(await page.text()).not.toContain('<button');
    } finally {
      await close(web);
    }
  },
);

async function listen(server: Server): Promise<string> {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('port');
  return `http://127.0.0.1:${address.port}`;
}

function close(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => (error === undefined ? resolve() : reject(error)));
  });
}
