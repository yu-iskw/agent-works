import { randomUUID } from 'node:crypto';

import { expect, it } from 'vitest';

import { createMemoryLedgerPort } from '../../apps/api/src/ports/memory/ledger-port.js';
import { createCorpusPort } from '../../apps/api/src/retrieval/search.js';
import { startStack } from '../../apps/api/src/testing/stack.js';
import { createLlm } from '../../packages/fakes/src/fake-llm.js';
import { listen } from '../../packages/fakes/src/http.js';
import { writePng } from '../png.mjs';
import { appendResult } from '../results.mjs';

import type { LedgerPort } from '../../apps/api/src/ports/ledger-port.js';
import type { IndexedDocument } from '../../apps/api/src/ports/search-port.js';
import type { OutboxEvent } from '@agent-works/domain';

const at = '2026-10-10T10:00:00.000Z';
const question = 'What are the triage runbook steps?';
const answer = 'Follow the triage steps in the Triage runbook.';
const toolVersion = '1';

const runbook: IndexedDocument = {
  citation: {
    sourceObjectId: 'alice-runbook',
    title: 'Triage runbook',
    sourceUri: 'https://drive.fake.test/d/alice-runbook',
    etag: 'etag-1',
    retrievedAt: at,
    accessDecisionId: 'drive:alice:alice-runbook',
    excerpt: 'Alice triage steps.',
  },
  groups: ['alice'],
  classification: 'INTERNAL',
  source: 'drive',
  region: 'us',
  text: `${question}\nAlice triage steps.`,
};

const recorded: OutboxEvent[] = [];
const previousRunner = process.env.AGENT_RUNNER;
const previousLlm = process.env.LLM_URL;

function observingLedger(): LedgerPort {
  const inner = createMemoryLedgerPort(() => new Date(at));
  return {
    submit(subject, request, idempotencyKey) {
      return inner.submit(subject, request, idempotencyKey);
    },
    read(subject, taskId) {
      return inner.read(subject, taskId);
    },
    append(event) {
      recorded.push(event);
      return inner.append(event);
    },
  };
}

it('audit.reconcile', async () => {
  const llm = await listen(createLlm(), 0);
  process.env.AGENT_RUNNER = 'adk';
  process.env.LLM_URL = llm.url;
  const ledger = observingLedger();
  const stack = await startStack({
    now: () => new Date(at),
    wire: {
      search: createCorpusPort([runbook]),
      ledger,
      groups: () => Promise.resolve({ groups: ['alice'], observedAt: at }),
    },
  });
  try {
    const requestId = randomUUID();
    const response = await fetch(`${stack.iapUrl}/v1/ask`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-fake-user': 'alice' },
      body: JSON.stringify({ requestId, question }),
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      requestId,
      answer,
      citations: [
        {
          sourceObjectId: 'alice-runbook',
          title: 'Triage runbook',
          sourceUri: 'https://drive.fake.test/d/alice-runbook',
          retrievedAt: at,
          excerpt: 'Alice triage steps.',
        },
      ],
    });
    const [event] = stack.audit.rows();
    expect(event?.initiatorSubject).toBe('alice');
    expect(event?.agentPrincipal).toBe('agent:adk-runner');
    expect(event?.tool).toBe(`drive.search@${toolVersion}`);
    expect(event?.schemaVersion).toBe(toolVersion);
    expect(event?.occurredAt).toBe(at);
    expect(event?.outcome).toBe('answered');
    expect(event?.policyDecisionId).toEqual(expect.any(String));
    expect(event?.taskId).not.toBe(requestId);
    const task = await ledger.read('alice', event?.taskId ?? '');
    expect(task?.createdBySub).toBe('alice');
    expect(recorded).toEqual([
      {
        destination: 'audit',
        event,
      },
    ]);
    appendResult({ id: 'audit.reconcile', status: 'passed' });
    writePng('e2e/artifacts/audit.reconcile/audit-reconcile.png', 'passed');
  } finally {
    await stack.close();
    await llm.close();
    if (previousRunner === undefined) delete process.env.AGENT_RUNNER;
    else process.env.AGENT_RUNNER = previousRunner;
    if (previousLlm === undefined) delete process.env.LLM_URL;
    else process.env.LLM_URL = previousLlm;
  }
});
