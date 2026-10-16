import { readFile } from 'node:fs/promises';
import { createServer, request as httpRequest } from 'node:http';
import { fileURLToPath } from 'node:url';

import { IAP_ASSERTION_HEADER } from '@agent-works/domain';
import { expect, test } from 'vitest';

import { createWebApp } from './web-app.js';

import type { IncomingMessage, Server } from 'node:http';

const clientDir = fileURLToPath(new URL('./fixtures/client/', import.meta.url));
const apiUrl = 'http://127.0.0.1:9';
const requestId = '11111111-1111-4111-8111-111111111111';
const question = 'where is the runbook?';

const answer = {
  requestId: '33333333-3333-4333-8333-333333333333',
  answer: 'Follow the triage steps.',
  citations: [
    {
      sourceObjectId: 'alice-runbook',
      title: 'Triage runbook',
      sourceUri: 'https://drive.fake.test/d/alice-runbook',
      retrievedAt: '2026-10-10T10:00:00.000Z',
      excerpt: 'Alice triage steps.',
    },
  ],
};

test('a valid ask is forwarded and the answer is returned', async () => {
  let forwarded: Request | undefined;
  await withServer(
    async (origin) => {
      const response = await fetch(`${origin}/api/ask`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          [IAP_ASSERTION_HEADER]: 'iap-assertion',
        },
        body: JSON.stringify({ requestId, question }),
      });
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual(answer);
      if (forwarded === undefined) throw new Error('missing forward');
      expect(forwarded.method).toBe('POST');
      expect(new URL(forwarded.url).pathname).toBe('/v1/ask');
      expect(forwarded.headers.get('content-type')).toBe('application/json');
      expect(forwarded.headers.get(IAP_ASSERTION_HEADER)).toBe('iap-assertion');
      expect(forwarded.headers.get('traceparent')).toMatch(
        /^00-11111111111141118111111111111111-[0-9a-f]{16}-01$/,
      );
      expect(await forwarded.json()).toEqual({ requestId, question });
    },
    (input, init) => {
      forwarded = new Request(input, init);
      return Promise.resolve(Response.json(answer));
    },
  );
});

test('an upstream conflict returns 409', async () => {
  await withServer(
    async (origin) => {
      const response = await postAsk(origin, { requestId, question });
      expect(response.status).toBe(409);
      expect(response.headers.get('content-type')).toBe('application/json; charset=utf-8');
      expect(await response.json()).toEqual({ message: 'That request was already used.' });
    },
    () => Promise.resolve(Response.json({ error: 'conflict' })),
  );
});

test('a rejected fetch returns 503', async () => {
  await withServer(
    async (origin) => {
      const response = await postAsk(origin, { requestId, question });
      expect(response.status).toBe(503);
      expect(await response.json()).toEqual({ message: 'The service is unavailable.' });
    },
    () => Promise.reject(new Error('down')),
  );
});

test('an invalid body returns 400 and does not call upstream', async () => {
  let calls = 0;
  await withServer(
    async (origin) => {
      const response = await fetch(`${origin}/api/ask`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: 'not-json',
      });
      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({ message: 'That question is not valid.' });
      expect(calls).toBe(0);
    },
    () => {
      calls += 1;
      return Promise.reject(new Error('should not be called'));
    },
  );
});

test('GET / serves the client index and GET /healthz returns ok', async () => {
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- fixed test fixture
  const indexHtml = await readFile(
    new URL('./fixtures/client/index.html', import.meta.url),
    'utf8',
  );
  await withServer(async (origin) => {
    const page = await fetch(`${origin}/`);
    expect(page.status).toBe(200);
    expect(page.headers.get('content-type')).toBe('text/html; charset=utf-8');
    expect(await page.text()).toBe(indexHtml);
    const health = await fetch(`${origin}/healthz`);
    expect(health.status).toBe(200);
    expect(health.headers.get('content-type')).toBe('text/plain; charset=utf-8');
    expect(await health.text()).toBe('ok');
  });
});

test('a percent-encoded traversal returns 404', async () => {
  await withServer(async (origin) => {
    const response = await rawGet(origin, '/%2e%2e/package.json');
    expect(response.status).toBe(404);
    expect(response.body).toBe('not found');
  });
});

function postAsk(origin: string, body: { requestId: string; question: string }): Promise<Response> {
  return fetch(`${origin}/api/ask`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

async function withServer(
  run: (origin: string) => Promise<void>,
  load?: typeof fetch,
): Promise<void> {
  const server = createServer(createWebApp({ apiUrl, clientDir, fetch: load }));
  await listen(server);
  try {
    await run(address(server));
  } finally {
    await close(server);
  }
}

function address(server: Server): string {
  const value = server.address();
  if (value === null || typeof value === 'string') throw new Error('port');
  return `http://127.0.0.1:${value.port}`;
}

function listen(server: Server): Promise<void> {
  return new Promise((resolvePromise, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      resolvePromise();
    });
  });
}

function close(server: Server): Promise<void> {
  return new Promise((resolvePromise, reject) => {
    server.close((error) => {
      if (error) reject(error);
      else resolvePromise();
    });
  });
}

function rawGet(origin: string, target: string): Promise<{ status: number; body: string }> {
  const url = new URL(origin);
  return new Promise((resolvePromise, reject) => {
    const req = httpRequest(
      { hostname: url.hostname, port: url.port, path: target, method: 'GET' },
      (response) => {
        readIncoming(response).then((body) => {
          resolvePromise({ status: response.statusCode ?? 0, body });
        }, reject);
      },
    );
    req.on('error', reject);
    req.end();
  });
}

function readIncoming(response: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  return new Promise((resolvePromise, reject) => {
    response.on('data', (chunk: Buffer) => {
      chunks.push(chunk);
    });
    response.on('end', () => {
      resolvePromise(Buffer.concat(chunks).toString('utf8'));
    });
    response.on('error', reject);
  });
}
