import { createServer } from 'node:http';

import { expect, test } from 'vitest';

import { createWebApp } from './web-app.js';

import type { Server } from 'node:http';

test('a failed ask keeps the question in the input', async () => {
  const server = createServer(
    createWebApp({
      apiUrl: 'http://127.0.0.1:9',
      fetch: () => Promise.reject(new Error('down')),
      newRequestId: () => '22222222-2222-4222-8222-222222222222',
    }),
  );
  await listen(server);
  try {
    const response = await fetch(address(server), {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        question: 'where is the runbook?',
        requestId: '11111111-1111-4111-8111-111111111111',
      }),
    });
    expect(response.status).toBe(200);
    expect(await response.text()).toContain('value="where is the runbook?"');
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => {
        if (error) reject(error);
        else resolve();
      });
    });
  }
});

test('an answered ask shows the retrieved time and the excerpt', async () => {
  const server = createServer(
    createWebApp({
      apiUrl: 'http://127.0.0.1:9',
      fetch: () =>
        Promise.resolve(
          Response.json({
            requestId: '11111111-1111-4111-8111-111111111111',
            answer: 'Follow the triage steps in the Triage runbook.',
            citations: [
              {
                sourceObjectId: 'alice-runbook',
                title: 'Triage runbook',
                sourceUri: 'https://drive.fake.test/d/alice-runbook',
                retrievedAt: '2026-10-10T10:00:00.000Z',
                excerpt: 'Alice triage steps.',
              },
            ],
          }),
        ),
      newRequestId: () => '22222222-2222-4222-8222-222222222222',
    }),
  );
  await listen(server);
  try {
    const response = await fetch(address(server), {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        question: 'where is the runbook?',
        requestId: '11111111-1111-4111-8111-111111111111',
      }),
    });
    expect(response.status).toBe(200);
    const html = await response.text();
    expect(html).toContain('datetime="2026-10-10T10:00:00.000Z"');
    expect(html).toContain('2026-10-10T10:00:00.000Z</time>');
    expect(html).toContain('Alice triage steps.');
    expect(html).toContain('Triage runbook');
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => {
        if (error) reject(error);
        else resolve();
      });
    });
  }
});

function address(server: Server): string {
  const value = server.address();
  if (value === null || typeof value === 'string') throw new Error('port');
  return `http://127.0.0.1:${value.port}/`;
}

function listen(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      resolve();
    });
  });
}
