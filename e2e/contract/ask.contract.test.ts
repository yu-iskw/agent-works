import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterAll, afterEach, beforeAll, expect, it, vi } from 'vitest';
import * as z from 'zod';

import { RunnerError } from '../../apps/api/src/agent/runner-port.js';
import { createMemoryLedgerPort } from '../../apps/api/src/ports/memory/ledger-port.js';
import { startStack } from '../../apps/api/src/testing/stack.js';
import { taskAuthorization } from '../../apps/api/src/testing/task-authorization.js';

import type { Stack } from '../../apps/api/src/testing/stack.js';

const askResponsePath = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '../../contracts/schemas/ask-response.json',
);

const published = z.fromJSONSchema(JSON.parse(readFileSync(askResponsePath, 'utf8')));

let stack: Stack;

beforeAll(async () => {
  stack = await startStack({ now: () => new Date('2026-10-10T10:00:00.000Z') });
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
        retrievedAt: '2026-10-10T10:00:00.000Z',
        excerpt: 'Alice triage steps.',
      },
    ],
  });
});

const recoveryStacks: Stack[] = [];
const recoveredAt = '2026-10-10T10:00:00.000Z';

afterEach(async () => {
  for (const recoveryStack of recoveryStacks.splice(0)) await recoveryStack.close();
  vi.restoreAllMocks();
});

it.each(['answered', 'runner_failed'] as const)(
  'contract.ask.lost-ack-%s-new-attempt-matches-response',
  async (outcome) => {
    const recovery = await lostAckStack(outcome);
    const response = await retry(recovery.stack, recovery.requestId);
    expect(response.status).toBe(200);
    const body: unknown = await response.json();
    expect(published.safeParse(body).success).toBe(true);
    expect(body).toMatchObject({ requestId: recovery.requestId, answer: 'retry answer' });
    const event = recovery.stack.audit.rows()[0];
    expect(event).toMatchObject({
      outcome: 'answered',
      agentPrincipal: 'agent:scripted-runner',
      policyDecisionId: expect.any(String),
      traceId: recovery.requestId.replaceAll('-', ''),
      taskId: recovery.original?.event.taskId,
    });
    expect(event.eventId).not.toBe(recovery.requestId);
    expect(event.policyDecisionId).not.toBe(recovery.original?.event.policyDecisionId);
    expect(await recovery.ledger.readOutbox(event.eventId)).toEqual({
      destination: 'audit',
      event,
    });
    expect(await recovery.ledger.readOutbox(recovery.requestId)).toEqual(recovery.original);
    expect(await recovery.submit.mock.results[0].value).toEqual(
      await recovery.submit.mock.results[1].value,
    );
    const duplicate = await retry(recovery.stack, recovery.requestId);
    expect(duplicate.status).toBe(409);
    expect(await duplicate.json()).toEqual({ error: 'conflict' });
    expect(recovery.runner.run).toHaveBeenCalledTimes(2);
  },
);

it('contract.ask.lost-ack-concurrent-retries-one-new-attempt', async () => {
  const recovery = await lostAckStack('answered');
  const replies = await Promise.all([
    retry(recovery.stack, recovery.requestId),
    retry(recovery.stack, recovery.requestId),
  ]);
  const results = await Promise.all(
    replies.map(async (reply) => ({
      status: reply.status,
      body: (await reply.json()) as unknown,
    })),
  );
  results.sort((left, right) => left.status - right.status);
  expect(results).toEqual([
    { status: 200, body: { requestId: recovery.requestId, answer: 'retry answer', citations: [] } },
    { status: 409, body: { error: 'conflict' } },
  ]);
  expect(recovery.runner.run).toHaveBeenCalledTimes(2);
  expect(recovery.stack.audit.rows()).toHaveLength(1);
  const event = recovery.stack.audit.rows()[0];
  expect(event.eventId).not.toBe(recovery.requestId);
  expect(event).toMatchObject({ outcome: 'answered', taskId: recovery.original?.event.taskId });
  expect(await recovery.ledger.readOutbox(event.eventId)).toEqual({ destination: 'audit', event });
  expect(await recovery.ledger.readOutbox(recovery.requestId)).toEqual(recovery.original);
});

async function lostAckStack(outcome: 'answered' | 'runner_failed') {
  const ledger = createMemoryLedgerPort(() => new Date(recoveredAt));
  const submit = vi.spyOn(ledger, 'submit');
  const append = ledger.append.bind(ledger);
  vi.spyOn(ledger, 'append').mockImplementationOnce(async (event) => {
    await append(event);
    throw new Error('lost acknowledgement');
  });
  const runner = { run: vi.fn() };
  if (outcome === 'answered') {
    runner.run.mockResolvedValueOnce({ answer: 'original answer', citedSourceIds: [] });
  } else {
    runner.run.mockRejectedValueOnce(new RunnerError('original failure'));
  }
  runner.run.mockResolvedValue({ answer: 'retry answer', citedSourceIds: [] });
  const recoveryStack = await startStack({
    runner,
    now: () => new Date(recoveredAt),
    wire: {
      ledger,
      groups: () =>
        Promise.resolve({ groups: ['agent-users@company.example'], observedAt: recoveredAt }),
      policyInput: taskAuthorization.wire.policyInput,
      search: {
        search: () =>
          Promise.resolve([
            {
              sourceObjectId: 'runbook',
              title: 'Runbook',
              sourceUri: 'https://drive.fake.test/d/runbook',
              text: 'steps',
              excerpt: 'steps',
              retrievedAt: recoveredAt,
              etag: '1',
              accessDecisionId: 'access',
            },
          ]),
      },
    },
  });
  recoveryStacks.push(recoveryStack);
  const requestId = randomUUID();
  expect((await retry(recoveryStack, requestId)).status).toBe(500);
  const original = await ledger.readOutbox(requestId);
  expect(original?.event.outcome).toBe(outcome);
  expect(recoveryStack.audit.rows()).toEqual([]);
  return { stack: recoveryStack, requestId, original, ledger, runner, submit };
}

function retry(recoveryStack: Stack, requestId: string) {
  return fetch(`${recoveryStack.iapUrl}/v1/ask`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-fake-user': 'alice' },
    body: JSON.stringify({ requestId, question: 'What are the triage runbook steps?' }),
  });
}
