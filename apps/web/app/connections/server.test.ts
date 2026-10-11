import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { createServer } from 'node:http';

import { expect, test, vi } from 'vitest';

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
  const api = createServer((request, response) => {
    void (async () => {
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
      } else
        response.end(
          JSON.stringify({
            ...connection,
            status: request.method === 'DELETE' ? 'revoked' : 'active',
          }),
        );
    })();
  });
  api.listen(0, '127.0.0.1');
  await once(api, 'listening');
  const { createWebServer } = await import('../../src/server.js');
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
    vi.unstubAllEnvs();
  }
});

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
