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
