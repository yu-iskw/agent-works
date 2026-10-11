import { randomUUID } from 'node:crypto';

import { afterEach, describe, expect, it } from 'vitest';

import { RetrievalError } from '../retrieval/drive-port.js';
import { createMemoryAuditLog, startStack } from '../testing/stack.js';

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

  it('cites only the document the answer used', async () => {
    const handbook = {
      id: 'public-handbook',
      title: 'Public handbook',
      text: 'Anyone may read this handbook.',
      uri: 'https://drive.fake.test/d/public-handbook',
    };
    const stack = await open(stacks, {
      drive: {
        retrieve: () => Promise.resolve([runbook, handbook]),
      },
      runner: {
        run: () =>
          Promise.resolve({
            answer: triageAnswer,
            citedSourceIds: [runbook.id],
          }),
      },
    });
    const requestId = randomUUID();
    const response = await post(stack.iapUrl, requestId, triageQuestion);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(answered(requestId, triageAnswer));
  });

  it('returns 409 when the same request id is retried', async () => {
    const calls = { drive: 0, runner: 0 };
    const stack = await open(stacks, countingPorts(calls));
    const requestId = randomUUID();
    const first = await post(stack.iapUrl, requestId, triageQuestion);
    expect(first.status).toBe(200);
    expect(await first.json()).toEqual(generated(requestId, 1));
    const second = await post(stack.iapUrl, requestId, triageQuestion);
    expect(second.status).toBe(409);
    expect(await second.json()).toEqual({ error: 'conflict' });
    expect(calls).toEqual({ drive: 1, runner: 1 });
    expect(stack.audit.rows()).toEqual([row(requestId, triageDigest, 'answered')]);
  });

  it('returns 409 to a concurrent duplicate and runs the model once', async () => {
    const calls = { drive: 0, runner: 0 };
    const stack = await open(stacks, countingPorts(calls));
    const requestId = randomUUID();
    const [first, second] = await Promise.all([
      post(stack.iapUrl, requestId, triageQuestion),
      post(stack.iapUrl, requestId, triageQuestion),
    ]);
    const firstBody: unknown = await first.json();
    const secondBody: unknown = await second.json();
    const parsed = [
      { status: first.status, body: firstBody },
      { status: second.status, body: secondBody },
    ].sort((left, right) => left.status - right.status);
    expect(parsed).toEqual([
      { status: 200, body: generated(requestId, 1) },
      { status: 409, body: { error: 'conflict' } },
    ]);
    expect(calls).toEqual({ drive: 1, runner: 1 });
    expect(stack.audit.rows()).toEqual([row(requestId, triageDigest, 'answered')]);
  });

  it('returns 409 from a second route that shares the audit log', async () => {
    const shared = createMemoryAuditLog();
    const firstCalls = { drive: 0, runner: 0 };
    const secondCalls = { drive: 0, runner: 0 };
    const first = await open(stacks, {
      audit: shared,
      ...scriptedPorts(firstCalls, 'from-first-route'),
    });
    const second = await open(stacks, {
      audit: shared,
      ...scriptedPorts(secondCalls, 'from-second-route'),
    });
    const requestId = randomUUID();
    const firstResponse = await post(first.iapUrl, requestId, triageQuestion);
    expect(firstResponse.status).toBe(200);
    expect(await firstResponse.json()).toEqual(answered(requestId, 'from-first-route'));
    const secondResponse = await post(second.iapUrl, requestId, triageQuestion);
    expect(secondResponse.status).toBe(409);
    expect(await secondResponse.json()).toEqual({ error: 'conflict' });
    expect(firstCalls).toEqual({ drive: 1, runner: 1 });
    expect(secondCalls).toEqual({ drive: 0, runner: 0 });
    expect(shared.rows()).toEqual([row(requestId, triageDigest, 'answered')]);
  });

  it('does not rerun a request id that already has an audit row', async () => {
    const requestId = randomUUID();
    const legacy = row(requestId, triageDigest, 'answered');
    const shared = createMemoryAuditLog([legacy]);
    const calls = { drive: 0, runner: 0 };
    const stack = await open(stacks, { audit: shared, ...countingPorts(calls) });
    const response = await post(stack.iapUrl, requestId, triageQuestion);
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: 'conflict' });
    expect(calls).toEqual({ drive: 0, runner: 0 });
    expect(shared.rows()).toEqual([legacy]);
    const again = await post(stack.iapUrl, requestId, triageQuestion);
    expect(again.status).toBe(409);
    expect(calls).toEqual({ drive: 0, runner: 0 });
    expect(shared.rows()).toEqual([legacy]);
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

  it('returns 500 and then the triage answer when retrieve throws', async () => {
    let calls = 0;
    const stack = await open(stacks, {
      drive: {
        retrieve() {
          calls += 1;
          if (calls === 1) return Promise.reject(new Error('boom'));
          return Promise.resolve([runbook]);
        },
      },
    });
    const requestId = randomUUID();
    const first = await post(stack.iapUrl, requestId, triageQuestion);
    expect(first.status).toBe(500);
    expect(await first.text()).toBe('error');
    const second = await post(stack.iapUrl, requestId, triageQuestion);
    expect(second.status).toBe(200);
    expect(await second.json()).toEqual(answered(requestId, triageAnswer));
    expect(stack.audit.rows()).toEqual([row(requestId, triageDigest, 'answered')]);
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

const runbook = {
  id: 'alice-runbook',
  title: 'Triage runbook',
  text: 'Alice triage steps.',
  uri: 'https://drive.fake.test/d/alice-runbook',
} as const;

function countingPorts(calls: { drive: number; runner: number }): Parameters<typeof startStack>[0] {
  return {
    drive: {
      retrieve() {
        calls.drive += 1;
        return Promise.resolve([runbook]);
      },
    },
    runner: {
      run() {
        calls.runner += 1;
        return Promise.resolve({
          answer: `generated-${calls.runner}`,
          citedSourceIds: [runbook.id],
        });
      },
    },
  };
}

function scriptedPorts(
  calls: { drive: number; runner: number },
  answer: string,
): Parameters<typeof startStack>[0] {
  return {
    drive: {
      retrieve() {
        calls.drive += 1;
        return Promise.resolve([runbook]);
      },
    },
    runner: {
      run() {
        calls.runner += 1;
        return Promise.resolve({ answer, citedSourceIds: [runbook.id] });
      },
    },
  };
}

function answered(requestId: string, answer: string) {
  return {
    requestId,
    answer,
    citations: [
      {
        sourceObjectId: runbook.id,
        title: runbook.title,
        sourceUri: runbook.uri,
      },
    ],
  };
}

function generated(requestId: string, generation: number) {
  return {
    requestId,
    answer: `generated-${generation}`,
    citations: [
      {
        sourceObjectId: runbook.id,
        title: runbook.title,
        sourceUri: runbook.uri,
      },
    ],
  };
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
