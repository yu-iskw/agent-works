import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { createServer } from 'node:http';

import { expect, test, vi } from 'vitest';

import { createWebServer } from '../../src/server.js';

import type { Server } from 'node:http';

const connection = {
  kind: 'connection',
  provider: 'google',
  subject: 'alice',
  scope: 'https://www.googleapis.com/auth/drive.readonly',
  status: 'active',
  expiresAt: '2099-01-01T00:00:00.000Z',
  tokenRef: 'private-reference',
};

test('the real web server serves connections, completes its callback and disconnects', async () => {
  const calls: { method?: string; assertion?: string; body: Record<string, string> }[] = [];
  let status: string | undefined;
  const reads: string[] = [];
  const api = createServer((request, response) => {
    void (async () => {
      if (request.method === 'GET') {
        reads.push(request.url ?? '');
        response.setHeader('content-type', 'application/json');
        response.end(
          JSON.stringify({
            kind: 'connections',
            connections:
              status === undefined
                ? []
                : [
                    {
                      provider: connection.provider,
                      scope: connection.scope,
                      status,
                      expiresAt: connection.expiresAt,
                    },
                  ],
          }),
        );
        return;
      }
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk as Uint8Array));
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}') as Record<
        string,
        string
      >;
      calls.push({
        method: request.method,
        assertion: request.headers['x-goog-iap-jwt-assertion'] as string | undefined,
        body,
      });
      response.setHeader('content-type', 'application/json');
      if (body.kind === 'start') {
        response.end(
          JSON.stringify({
            ...body,
            kind: 'started',
            authorizationUrl: `http://provider.test/authorize?state=${body.state}`,
          }),
        );
      } else {
        status = request.method === 'DELETE' ? 'revoked' : 'active';
        response.end(
          JSON.stringify({
            ...connection,
            status,
          }),
        );
      }
    })();
  });
  api.listen(0, '127.0.0.1');
  await once(api, 'listening');
  const server = createWebServer({ apiUrl: address(api) }).listen(0, '127.0.0.1');
  await once(server, 'listening');
  const headers = { 'x-goog-iap-jwt-assertion': 'test-assertion' };
  try {
    const ready = await fetch(`${address(server)}/connections`);
    expect(ready.status).toBe(200);
    const cookie = ready.headers.get('set-cookie')?.split(';')[0] ?? '';
    expect(cookie).toMatch(/^connections=/);
    const html = await ready.text();
    expect(html).toMatch(/<h1[^>]*>Connections<\/h1>/);
    const csrf = /name="csrf" value="([^"]+)"/.exec(html)?.[1] ?? '';
    expect(csrf).not.toBe('');
    const invalid = await fetch(`${address(server)}/connections/connect`, {
      method: 'POST',
      headers: { cookie },
      body: 'csrf=wrong',
    });
    expect(invalid.status).toBe(400);
    expect(calls).toHaveLength(0);
    const started = await fetch(`${address(server)}/connections/connect`, {
      method: 'POST',
      headers: { ...headers, cookie },
      body: new URLSearchParams({ csrf }),
      redirect: 'manual',
    });
    expect(started.status).toBe(303);
    expect(started.headers.get('location')).toMatch(/^http:\/\/provider.test\/authorize/);
    const start = calls[0].body;
    expect(start.codeChallengeMethod).toBe('S256');
    const badCallback = await fetch(`${address(server)}/oauth/callback?state=wrong&code=code`, {
      headers: { ...headers, cookie },
    });
    expect(badCallback.status).toBe(400);
    expect(calls).toHaveLength(1);
    const completed = await fetch(
      `${address(server)}/oauth/callback?state=${start.state}&code=code`,
      { headers: { ...headers, cookie }, redirect: 'manual' },
    );
    expect(completed.status).toBe(303);
    expect(completed.headers.get('location')).toBe('/connections');
    expect(calls[1].body.kind).toBe('callback');
    expect(createHash('sha256').update(calls[1].body.codeVerifier).digest('base64url')).toBe(
      start.codeChallenge,
    );
    expect(calls.map((call) => call.assertion)).toEqual(['test-assertion', 'test-assertion']);
    const connected = await fetch(`${address(server)}/connections`, { headers: { cookie } });
    const connectedHtml = await connected.text();
    expect(connectedHtml).toContain('active');
    expect(connectedHtml).not.toContain(connection.tokenRef);
    expect(connectedHtml).not.toContain(connection.subject);
    expect(reads.every((path) => path === '/v1/oauth/connections')).toBe(true);
    expect(reads).toHaveLength(4);
    expect(connectedHtml).not.toContain(calls[1].body.codeVerifier);
    const replay = await fetch(`${address(server)}/oauth/callback?state=${start.state}&code=code`, {
      headers: { ...headers, cookie },
    });
    expect(replay.status).toBe(400);
    expect(calls).toHaveLength(2);
    const disconnected = await fetch(`${address(server)}/connections/disconnect`, {
      method: 'POST',
      headers: { ...headers, cookie },
      body: new URLSearchParams({ csrf }),
      redirect: 'manual',
    });
    expect(disconnected.status).toBe(303);
    expect(calls[2].method).toBe('DELETE');
    const revoked = await fetch(`${address(server)}/connections`, { headers: { cookie } });
    expect(await revoked.text()).toContain('revoked');
    const home = await fetch(address(server));
    expect(await home.text()).toMatch(/<h1[^>]*>Ask<\/h1>/);
  } finally {
    await Promise.all([close(server), close(api)]);
  }
});

test('connection status survives cookie reset, session expiry and a web server restart', async () => {
  const apiFetch = vi
    .fn<typeof fetch>()
    .mockImplementation(() =>
      Promise.resolve(Response.json({ kind: 'connections', connections: [summary()] })),
    );
  let server = createWebServer({ apiUrl: 'http://api.test', fetch: apiFetch }).listen(
    0,
    '127.0.0.1',
  );
  await once(server, 'listening');
  try {
    const first = await fetch(`${address(server)}/connections`);
    const cookie = first.headers.get('set-cookie')?.split(';')[0] ?? '';
    expect(await first.text()).toContain('Disconnect');
    const reset = await fetch(`${address(server)}/connections`);
    expect(await reset.text()).toContain('Disconnect');
    expect(reset.headers.get('set-cookie')).not.toContain(cookie);
    const now = vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 31 * 60 * 1000);
    const expired = await fetch(`${address(server)}/connections`, { headers: { cookie } });
    now.mockRestore();
    expect(await expired.text()).toContain('Disconnect');
    expect(expired.headers.get('set-cookie')).not.toContain(cookie);
    await close(server);
    server = createWebServer({ apiUrl: 'http://api.test', fetch: apiFetch }).listen(0, '127.0.0.1');
    await once(server, 'listening');
    const restarted = await fetch(`${address(server)}/connections`, { headers: { cookie } });
    expect(await restarted.text()).toContain('Disconnect');
    expect(apiFetch).toHaveBeenCalledTimes(4);
  } finally {
    vi.restoreAllMocks();
    await close(server);
  }
});

test('an expired callback session can still disconnect the persisted connection', async () => {
  const apiFetch = vi
    .fn<typeof fetch>()
    .mockImplementation((_url, init) =>
      Promise.resolve(
        Response.json(
          init?.method === 'DELETE'
            ? { ...connection, status: 'revoked' }
            : { kind: 'connections', connections: [summary()] },
        ),
      ),
    );
  const server = createWebServer({ apiUrl: 'http://api.test', fetch: apiFetch }).listen(
    0,
    '127.0.0.1',
  );
  await once(server, 'listening');
  try {
    const callback = await fetch(`${address(server)}/oauth/callback?state=expired&code=unused`);
    expect(callback.status).toBe(400);
    const html = await callback.text();
    expect(html).toContain('Disconnect');
    const csrf = /name="csrf" value="([^"]+)"/.exec(html)?.[1] ?? '';
    expect(csrf).not.toBe('');
    const disconnected = await fetch(`${address(server)}/connections/disconnect`, {
      method: 'POST',
      headers: { cookie: callback.headers.get('set-cookie')?.split(';')[0] ?? '' },
      body: new URLSearchParams({ csrf }),
      redirect: 'manual',
    });
    expect(disconnected.status).toBe(303);
    expect(apiFetch).toHaveBeenCalledTimes(2);
  } finally {
    await close(server);
  }
});

test.each(['active', 'revoked', 'expired'] as const)(
  'every render reads current %s status and scope for the asserted caller',
  async (status) => {
    const apiFetch = vi
      .fn<typeof fetch>()
      .mockImplementation(() =>
        Promise.resolve(Response.json({ kind: 'connections', connections: [summary(status)] })),
      );
    const server = createWebServer({ apiUrl: 'http://api.test', fetch: apiFetch }).listen(
      0,
      '127.0.0.1',
    );
    await once(server, 'listening');
    try {
      const response = await fetch(`${address(server)}/connections?subject=mallory`, {
        headers: {
          'x-goog-iap-jwt-assertion': 'signed-caller',
          'x-goog-authenticated-user-id': 'mallory',
          'x-user-id': 'mallory',
        },
      });
      const html = await response.text();
      expect(html).toContain(`>${status}</p>`);
      expect(html).toContain(connection.scope);
      expect(html).not.toContain('mallory');
      expect(html.includes('Disconnect')).toBe(status !== 'revoked');
      expect(html.includes('>Connect<')).toBe(status !== 'active');
      expect(apiFetch).toHaveBeenCalledWith(
        new URL('http://api.test/v1/oauth/connections'),
        expect.objectContaining({
          method: 'GET',
          cache: 'no-store',
          headers: {
            'content-type': 'application/json',
            'x-goog-iap-jwt-assertion': 'signed-caller',
          },
        }),
      );
      apiFetch.mockImplementation(() =>
        Promise.resolve(Response.json({ kind: 'connections', connections: [] })),
      );
      const refreshed = await fetch(`${address(server)}/connections`, {
        headers: { cookie: response.headers.get('set-cookie')?.split(';')[0] ?? '' },
      });
      expect(await refreshed.text()).toContain('Not connected');
    } finally {
      await close(server);
    }
  },
);

test.each(['401', '503', 'network', 'json', 'schema', 'secrets'] as const)(
  'failed %s reads never imply disconnected or expose secrets',
  async (failure) => {
    const apiFetch: typeof fetch = () => {
      if (failure === 'network') return Promise.reject(new Error('private-access-token'));
      if (failure === 'json') return Promise.resolve(new Response('private-refresh-token'));
      if (failure === 'schema') return Promise.resolve(Response.json(connection));
      if (failure === 'secrets')
        return Promise.resolve(
          Response.json({
            kind: 'connections',
            connections: [
              {
                ...summary(),
                accessToken: 'private-access-token',
                refreshToken: 'private-refresh-token',
                codeVerifier: 'private-verifier',
                subject: 'private-user',
              },
            ],
          }),
        );
      return Promise.resolve(
        Response.json({ error: 'private-access-token' }, { status: Number(failure) }),
      );
    };
    const server = createWebServer({ apiUrl: 'http://api.test', fetch: apiFetch }).listen(
      0,
      '127.0.0.1',
    );
    await once(server, 'listening');
    try {
      const response = await fetch(`${address(server)}/connections`);
      expect(response.status).toBe(502);
      const html = await response.text();
      expect(html).toContain('Connection status unavailable');
      expect(html).not.toContain('Not connected');
      expect(html).not.toContain('<form');
      expect(html).not.toContain('private-');
    } finally {
      await close(server);
    }
  },
);

function summary(status: 'active' | 'revoked' | 'expired' = 'active') {
  return {
    provider: connection.provider,
    scope: connection.scope,
    status,
    expiresAt: connection.expiresAt,
  };
}

function address(server: Server): string {
  const value = server.address();
  if (value === null || typeof value === 'string') throw new Error('port');
  return `http://127.0.0.1:${value.port}`;
}

function close(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}
