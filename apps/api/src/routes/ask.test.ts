import { randomUUID } from 'node:crypto';

import { afterEach, describe, expect, it } from 'vitest';

import { RetrievalError } from '../retrieval/drive-port.js';
import { startStack } from '../testing/stack.js';

import type { Stack } from '../testing/stack.js';
import type { AuditEvent } from '@agent-works/domain';

const triageQuestion = 'What are the triage runbook steps?';
const triageAnswer = 'Follow the triage steps in the Triage runbook.';
const triageDigest = 'd10518952801d94803ef1162ec3fefbea9dfe82690ef52065439be6b3d55dd59';
const noSourcesAnswer = 'I could not find a source for that.';
const fixedNow = '2026-10-10T10:00:00.000Z';

describe('POST /v1/ask', () => {
  const stacks: Stack[] = [];

  afterEach(async () => {
    const open = stacks.splice(0);
    for (const stack of open) await stack.close();
  });

  it('returns 401 and writes nothing when the assertion is missing', async () => {
    const stack = await open(stacks);
    const response = await fetch(`${stack.apiUrl}/v1/ask`, { method: 'POST', body: '{}' });
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: 'unauthenticated' });
    expect(stack.audit.rows()).toEqual([]);
  });

  it('returns the fixed answer and one no_sources row when the corpus is empty', async () => {
    const stack = await open(stacks, { drive: { retrieve: () => Promise.resolve([]) } });
    const requestId = randomUUID();
    const response = await post(stack.iapUrl, requestId, triageQuestion);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      requestId,
      answer: noSourcesAnswer,
      citations: [],
    });
    expect(stack.audit.rows()).toEqual([row(requestId, triageDigest, 'no_sources')]);
  });

  it('returns the triage answer, the runbook citation, and one alice row', async () => {
    const stack = await open(stacks);
    const requestId = randomUUID();
    const response = await post(stack.iapUrl, requestId, triageQuestion);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      requestId,
      answer: triageAnswer,
      citations: [
        {
          sourceObjectId: 'alice-runbook',
          title: 'Triage runbook',
          sourceUri: 'https://drive.fake.test/d/alice-runbook',
        },
      ],
    });
    expect(stack.audit.rows()).toEqual([row(requestId, triageDigest, 'answered')]);
  });

  it('keeps a single row when the same request id and question are replayed', async () => {
    const stack = await open(stacks);
    const requestId = randomUUID();
    const first = await post(stack.iapUrl, requestId, triageQuestion);
    const second = await post(stack.iapUrl, requestId, triageQuestion);
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(await second.json()).toEqual(await first.json());
    expect(stack.audit.rows()).toHaveLength(1);
  });

  it('returns 409 and keeps the original row when the same id asks a different question', async () => {
    const stack = await open(stacks);
    const requestId = randomUUID();
    const first = await post(stack.iapUrl, requestId, triageQuestion);
    expect(first.status).toBe(200);
    const original = structuredClone(stack.audit.rows()[0]);
    const second = await post(stack.iapUrl, requestId, 'What does the public handbook say?');
    expect(second.status).toBe(409);
    expect(await second.json()).toEqual({ error: 'conflict' });
    expect(stack.audit.rows()).toEqual([original]);
  });

  it('returns 409 when another caller reuses the request id', async () => {
    const stack = await open(stacks);
    const requestId = randomUUID();
    const first = await post(stack.iapUrl, requestId, triageQuestion);
    expect(first.status).toBe(200);
    const original = structuredClone(stack.audit.rows()[0]);
    const second = await post(stack.iapUrl, requestId, triageQuestion, 'bob');
    expect(second.status).toBe(409);
    expect(await second.json()).toEqual({ error: 'conflict' });
    expect(stack.audit.rows()).toEqual([original]);
  });

  it('returns 409 when a failed ask is retried with the same id', async () => {
    let calls = 0;
    const stack = await open(stacks, {
      drive: {
        retrieve() {
          calls += 1;
          if (calls === 1) return Promise.reject(new RetrievalError('down'));
          return Promise.resolve([
            {
              id: 'alice-runbook',
              title: 'Triage runbook',
              text: 'Alice triage steps.',
              uri: 'https://drive.fake.test/d/alice-runbook',
            },
          ]);
        },
      },
    });
    const requestId = randomUUID();
    const first = await post(stack.iapUrl, requestId, triageQuestion);
    expect(first.status).toBe(502);
    const original = structuredClone(stack.audit.rows()[0]);
    expect(original.outcome).toBe('retrieval_failed');
    const second = await post(stack.iapUrl, requestId, triageQuestion);
    expect(second.status).toBe(409);
    expect(stack.audit.rows()).toEqual([original]);
  });

  it('returns 413 when the body exceeds the limit', async () => {
    const stack = await open(stacks);
    const response = await fetch(`${stack.apiUrl}/v1/ask`, {
      method: 'POST',
      body: 'x'.repeat(20_000),
    });
    expect(response.status).toBe(413);
    expect(await response.json()).toEqual({ error: 'too_large' });
    expect(stack.audit.rows()).toEqual([]);
  });
});

async function open(stacks: Stack[], overrides?: Parameters<typeof startStack>[0]): Promise<Stack> {
  const stack = await startStack({ now: () => new Date(fixedNow), ...overrides });
  stacks.push(stack);
  return stack;
}

function post(url: string, requestId: string, question: string, user = 'alice'): Promise<Response> {
  return fetch(`${url}/v1/ask`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-fake-user': user },
    body: JSON.stringify({ requestId, question }),
  });
}

function row(requestId: string, requestDigestSha256: string, outcome: string): AuditEvent {
  return {
    eventId: requestId,
    eventType: 'ask',
    schemaVersion: '1',
    occurredAt: fixedNow,
    taskId: requestId,
    stepId: 'ask',
    traceId: requestId.replaceAll('-', ''),
    initiatorSubject: 'alice',
    agentPrincipal: 'agent:scripted-runner',
    tool: 'drive.list',
    policyDecisionId: null,
    approvalId: null,
    requestDigestSha256,
    outcome,
    externalObjectRef: null,
    prevDigest: null,
  };
}
