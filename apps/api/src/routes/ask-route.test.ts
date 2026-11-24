import { RunnerError } from '@agent-works/agent-runtime/port';
import * as policy from '@agent-works/policy';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { AuditWriteError, createMemoryAuditLog } from '../audit/write.js';
import { Unauthenticated, Unavailable } from '../auth/iap.js';
import { createMemoryLedgerPort } from '../ports/memory/ledger-port.js';
import { RetrievalError } from '../retrieval/drive-port.js';
import { ContextMismatch } from '../retrieval/search.js';

import { createAskRoute } from './ask.js';

import type { AskDeps } from './ask.js';
import type { Caller } from '../auth/iap.js';
import type { SourceDocument } from '../retrieval/drive-port.js';
import type { PolicyDecision } from '@agent-works/domain';
import type { PolicyFacts } from '@agent-works/policy';

// In-process characterization of POST /v1/ask: every status, body and audit row the route emits.

const at = '2026-10-10T10:00:00.000Z';
const requestId = '7f9c2ba4-e88f-4c1a-9d5e-3c2b1a0f9e8d';
const traceId = requestId.replaceAll('-', '');
const question = 'What are the triage runbook steps?';
const digest = 'd10518952801d94803ef1162ec3fefbea9dfe82690ef52065439be6b3d55dd59';
const alice = { sub: 'alice', assertion: 'assertion' } as Caller;
const runbook: SourceDocument = {
  id: 'alice-runbook',
  title: 'Triage runbook',
  text: 'Alice triage steps.',
  uri: 'https://drive.fake.test/d/alice-runbook',
};
const handbook: SourceDocument = {
  id: 'handbook',
  title: 'Handbook',
  text: 'Anyone may read this.',
  uri: 'https://drive.fake.test/d/handbook',
};
const allowedFacts: PolicyFacts = {
  approved_agent_and_skill_version: true,
  agent_has_tool_capability: true,
  user_or_service_has_resource_authority: true,
  source_system_allows_operation: true,
  data_classification_policy_allows: true,
  valid_approval_if_required: true,
  within_time_and_budget_bounds: true,
};

type Wire = NonNullable<AskDeps['wire']>;

function deps(patch: Partial<AskDeps> = {}) {
  const audit = createMemoryAuditLog();
  const runner = {
    run: vi.fn(() =>
      Promise.resolve({ answer: 'Follow the steps.', citedSourceIds: [runbook.id] }),
    ),
  };
  const retrieve = vi.fn(() => Promise.resolve<readonly SourceDocument[]>([runbook, handbook]));
  const all: AskDeps = {
    verify: (assertion) =>
      assertion === 'assertion'
        ? Promise.resolve(alice)
        : Promise.reject(new Unauthenticated('missing')),
    drive: { retrieve },
    runner,
    audit,
    now: () => new Date(at),
    ...patch,
  };
  return { all, audit, runner, retrieve, route: createAskRoute(all) };
}

function wired(patch: Partial<Wire> = {}) {
  const ledger = createMemoryLedgerPort(() => new Date(at));
  const submit = vi.spyOn(ledger, 'submit');
  const search = vi.fn(() =>
    Promise.resolve([
      {
        sourceObjectId: runbook.id,
        title: runbook.title,
        sourceUri: runbook.uri,
        etag: 'etag-1',
        retrievedAt: '2026-10-10T09:00:00.000Z',
        accessDecisionId: 'access-1',
        excerpt: 'Alice triage…',
        text: runbook.text,
      },
    ]),
  );
  const wire: Wire = {
    search: { search },
    ledger,
    groups: () => Promise.resolve({ groups: ['agent-users@company.example'], observedAt: at }),
    policyInput: () => Promise.resolve({ facts: allowedFacts }),
    ...patch,
  };
  return { ...deps({ wire }), ledger, submit, search };
}

function post(body: unknown, assertion: string | null = 'assertion') {
  return {
    method: 'POST',
    path: '/v1/ask',
    headers: assertion === null ? {} : { 'x-goog-iap-jwt-assertion': assertion },
    body: Buffer.from(typeof body === 'string' ? body : JSON.stringify(body)),
  };
}

const ask = post({ requestId, question });

function event(outcome: string, extra: Record<string, unknown> = {}) {
  return {
    eventId: requestId,
    eventType: 'ask',
    schemaVersion: '1',
    occurredAt: at,
    taskId: requestId,
    stepId: 'ask',
    traceId,
    initiatorSubject: 'alice',
    agentPrincipal: 'agent:scripted-runner',
    tool: 'drive.list',
    policyDecisionId: null,
    approvalId: null,
    requestDigestSha256: digest,
    outcome,
    externalObjectRef: null,
    prevDigest: null,
    ...extra,
  };
}

beforeEach(() => {
  vi.stubEnv('LLM_URL', '');
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe('ask route, unwired', () => {
  it('401 unauthenticated and no audit row without an assertion', async () => {
    const { route, audit } = deps();
    expect(await route(post({ requestId, question }, null))).toEqual({
      status: 401,
      body: { error: 'unauthenticated' },
    });
    expect(audit.rows()).toEqual([]);
  });

  it('503 unavailable when the verifier is down', async () => {
    const { route } = deps({ verify: () => Promise.reject(new Unavailable('jwks')) });
    expect(await route(ask)).toEqual({ status: 503, body: { error: 'unavailable' } });
  });

  it.each([['{'], [JSON.stringify({ requestId: 'nope', question })], ['']])(
    '400 invalid_request for body %j',
    async (body) => {
      const { route, audit } = deps();
      expect(await route(post(body))).toEqual({ status: 400, body: { error: 'invalid_request' } });
      expect(audit.rows()).toEqual([]);
    },
  );

  it('200 answered cites only used sources, defaulting retrievedAt and excerpt', async () => {
    const { route, audit, runner } = deps();
    expect(await route(ask)).toEqual({
      status: 200,
      body: {
        requestId,
        answer: 'Follow the steps.',
        citations: [
          {
            sourceObjectId: runbook.id,
            title: runbook.title,
            sourceUri: runbook.uri,
            retrievedAt: at,
            excerpt: runbook.text,
          },
        ],
      },
    });
    expect(runner.run).toHaveBeenCalledWith({ question, sources: [runbook, handbook] });
    expect(audit.rows()).toEqual([event('answered')]);
  });

  it('200 fixed answer and a no_sources row when nothing is retrieved', async () => {
    const { route, audit, runner } = deps({ drive: { retrieve: () => Promise.resolve([]) } });
    expect(await route(ask)).toEqual({
      status: 200,
      body: { requestId, answer: 'I could not find a source for that.', citations: [] },
    });
    expect(runner.run).not.toHaveBeenCalled();
    expect(audit.rows()).toEqual([event('no_sources')]);
  });

  it('502 retrieval_failed on RetrievalError', async () => {
    const { route, audit } = deps({
      drive: { retrieve: () => Promise.reject(new RetrievalError('down')) },
    });
    expect(await route(ask)).toEqual({ status: 502, body: { error: 'retrieval_failed' } });
    expect(audit.rows()).toEqual([event('retrieval_failed')]);
  });

  it('502 runner_failed on RunnerError', async () => {
    const { route, audit } = deps({
      runner: { run: () => Promise.reject(new RunnerError('model')) },
    });
    expect(await route(ask)).toEqual({ status: 502, body: { error: 'runner_failed' } });
    expect(audit.rows()).toEqual([event('runner_failed')]);
  });

  it('rethrows a non-runner failure without writing a row', async () => {
    const boom = new Error('boom');
    const { route, audit } = deps({ runner: { run: () => Promise.reject(boom) } });
    await expect(route(ask)).rejects.toBe(boom);
    expect(audit.rows()).toEqual([]);
  });

  it('409 conflict when the request id repeats', async () => {
    const { route, audit, runner } = deps();
    expect((await route(ask)).status).toBe(200);
    expect(await route(ask)).toEqual({ status: 409, body: { error: 'conflict' } });
    expect(runner.run).toHaveBeenCalledTimes(1);
    expect(audit.rows()).toHaveLength(1);
  });

  it('503 audit_failed when the audit log fails', async () => {
    const { route } = deps({
      audit: { run: () => Promise.reject(new AuditWriteError('audit write')) },
    });
    expect(await route(ask)).toEqual({ status: 503, body: { error: 'audit_failed' } });
  });
});

describe('ask route, wired', () => {
  it('200 answered: submits the task and appends the audit event to the outbox', async () => {
    const decide = vi.spyOn(policy, 'decide');
    const { route, audit, ledger, submit } = wired();
    expect(await route(ask)).toEqual({
      status: 200,
      body: {
        requestId,
        answer: 'Follow the steps.',
        citations: [
          {
            sourceObjectId: runbook.id,
            title: runbook.title,
            sourceUri: runbook.uri,
            retrievedAt: '2026-10-10T09:00:00.000Z',
            excerpt: 'Alice triage…',
          },
        ],
      },
    });
    expect(submit).toHaveBeenCalledWith(
      'alice',
      {
        objective: question,
        skillId: 'ask',
        sourceAllowlist: ['drive'],
        requestedOutputs: ['answer'],
        executionPolicy: { mode: 'interactive', budgetUsd: 0.1, deadlineSeconds: 30 },
      },
      requestId,
    );
    const accepted = (await submit.mock.results[0].value) as { taskId: string };
    const decision = decide.mock.results[0].value as PolicyDecision;
    const expected = event('answered', {
      taskId: accepted.taskId,
      tool: 'drive.search@1',
      policyDecisionId: decision.decisionId,
    });
    expect(audit.rows()).toEqual([expected]);
    expect(await ledger.readOutbox(requestId)).toEqual({ destination: 'audit', event: expected });
  });

  it('403 denied without the Employee role, before search or submit', async () => {
    const decide = vi.spyOn(policy, 'decide');
    const { route, audit, search, submit, runner } = wired({
      groups: () => Promise.resolve({ groups: [], observedAt: at }),
    });
    expect(await route(ask)).toEqual({ status: 403, body: { error: 'denied' } });
    const decision = decide.mock.results[0].value as PolicyDecision;
    expect(decision.effect).toBe('deny');
    expect(search).not.toHaveBeenCalled();
    expect(submit).not.toHaveBeenCalled();
    expect(runner.run).not.toHaveBeenCalled();
    expect(audit.rows()).toEqual([
      event('denied', { tool: null, policyDecisionId: decision.decisionId }),
    ]);
  });

  it('403 denied when group resolution fails', async () => {
    const { route, audit } = wired({ groups: () => Promise.reject(new Error('directory')) });
    expect(await route(ask)).toEqual({ status: 403, body: { error: 'denied' } });
    expect(audit.rows()).toMatchObject([{ outcome: 'denied', tool: null }]);
  });

  it('502 retrieval_failed on ContextMismatch, still submitting and auditing', async () => {
    const { route, audit, submit } = wired({
      search: { search: () => Promise.reject(new ContextMismatch()) },
    });
    expect(await route(ask)).toEqual({ status: 502, body: { error: 'retrieval_failed' } });
    expect(submit).toHaveBeenCalledTimes(1);
    expect(audit.rows()).toMatchObject([{ outcome: 'retrieval_failed', tool: 'drive.search@1' }]);
  });

  it('409 conflict when a persisted outbox event names another question', async () => {
    const first = wired();
    expect((await first.route(ask)).status).toBe(200);
    const { route, audit } = deps({
      audit: createMemoryAuditLog(),
      wire: {
        search: { search: () => Promise.resolve([]) },
        ledger: first.ledger,
        groups: () => Promise.resolve({ groups: ['agent-users@company.example'], observedAt: at }),
      },
    });
    expect(await route(post({ requestId, question: 'another question' }))).toEqual({
      status: 409,
      body: { error: 'conflict' },
    });
    expect(audit.rows()).toEqual([]);
  });
});
