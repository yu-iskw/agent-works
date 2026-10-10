import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterAll, beforeAll, expect, it } from 'vitest';
import * as z from 'zod';

import { startStack } from '../../apps/api/src/testing/stack.js';

import type { Stack } from '../../apps/api/src/testing/stack.js';

const askResponsePath = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '../../contracts/schemas/ask-response.json',
);

const published = z.fromJSONSchema(JSON.parse(readFileSync(askResponsePath, 'utf8')));

let stack: Stack;

beforeAll(async () => {
  stack = await startStack();
});

afterAll(async () => {
  await stack?.close();
});

it('contract.ask.no-assertion-401', async () => {
  const response = await fetch(`${stack.apiUrl}/v1/ask`, { method: 'POST', body: '{}' });
  expect(response.status).toBe(401);
  expect(await response.json()).toEqual({ error: 'unauthenticated' });
});

it('contract.ask.response-shape', async () => {
  const requestId = randomUUID();
  const response = await fetch(`${stack.iapUrl}/v1/ask`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-fake-user': 'alice' },
    body: JSON.stringify({ requestId, question: 'What are the triage runbook steps?' }),
  });
  expect(response.status).toBe(200);
  const body: unknown = await response.json();
  expect(published.safeParse(body).success).toBe(true);
  expect(body).toEqual({
    requestId,
    answer: 'Follow the triage steps in the Triage runbook.',
    citations: [
      {
        sourceObjectId: 'alice-runbook',
        title: 'Triage runbook',
        sourceUri: 'https://drive.fake.test/d/alice-runbook',
      },
    ],
  });
});
