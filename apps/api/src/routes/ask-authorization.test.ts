import { randomUUID } from 'node:crypto';

import { createDirectory, createDrive, listen } from '@agent-works/fakes';
import * as policy from '@agent-works/policy';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { RunnerError } from '../agent/runner-port.js';
import { createGroupResolver } from '../auth/directory.js';
import { createMemoryLedgerPort } from '../ports/memory/ledger-port.js';
import { createHttpDrive } from '../retrieval/http-drive.js';
import { ContextMismatch } from '../retrieval/search.js';
import { startStack } from '../testing/stack.js';

import type { AskDeps } from './ask.js';
import type { Caller } from '../auth/iap.js';
import type { Stack } from '../testing/stack.js';
import type { PolicyDecision, SearchContext } from '@agent-works/domain';
import type { PolicyFacts } from '@agent-works/policy';

const at = '2026-10-10T10:00:00.000Z';
const allowedFacts: PolicyFacts = {
  approved_agent_and_skill_version: true,
  agent_has_tool_capability: true,
  user_or_service_has_resource_authority: true,
  source_system_allows_operation: true,
  data_classification_policy_allows: true,
  valid_approval_if_required: true,
  within_time_and_budget_bounds: true,
};

describe('wired ask authorization', () => {
  const stacks: Stack[] = [];
  const closers: (() => Promise<void>)[] = [];

  afterEach(async () => {
    for (const stack of stacks.splice(0)) await stack.close();
    for (const close of closers.splice(0)) await close();
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  async function open(patch: Partial<NonNullable<AskDeps['wire']>> = {}, now = () => new Date(at)) {
    const search = vi.fn(() => Promise.resolve([]));
    const runner = { run: vi.fn() };
    const ledger = createMemoryLedgerPort(() => new Date(at));
    const submit = vi.spyOn(ledger, 'submit');
    const decision = vi.spyOn(policy, 'decide');
    const policyInput = vi.fn<NonNullable<NonNullable<AskDeps['wire']>['policyInput']>>(() =>
      Promise.resolve({ facts: allowedFacts }),
    );
    const groups = vi.fn(() =>
      Promise.resolve({ groups: ['agent-users@company.example'], observedAt: at }),
    );
    const stack = await startStack({
      now,
      runner,
      wire: { search: { search }, ledger, groups, policyInput, ...patch },
    });
    stacks.push(stack);
    return { stack, search, runner, submit, decision, policyInput, groups };
  }

  async function openDrive(handler: Parameters<typeof listen>[0]) {
    const server = await listen(handler, 0);
    closers.push(server.close);
    const drive = createHttpDrive({ baseUrl: server.url, now: () => new Date(at) });
    const callers = new WeakMap<SearchContext, Caller>();
    return open({
      policyInput: (caller, context) => {
        callers.set(context, caller);
        return Promise.resolve({ facts: allowedFacts });
      },
      search: {
        async search(context, question) {
          const caller = callers.get(context);
          if (caller === undefined) throw new ContextMismatch();
          const scope = await drive.open(caller);
          return scope.port.search(context, question);
        },
      },
    });
  }

  it('answers a natural language question from the seeded HttpDrive runbook', async () => {
    const ports = await openDrive(createDrive());
    ports.runner.run.mockResolvedValue({
      answer: 'Alice triage steps.',
      citedSourceIds: ['alice-runbook'],
    });
    const response = await post(ports.stack, 'What are the triage runbook steps?');
    expect(response.status).toBe(200);
    expect(ports.runner.run).toHaveBeenCalledWith({
      question: 'What are the triage runbook steps?',
      sources: [expect.objectContaining({ id: 'alice-runbook', text: 'Alice triage steps.' })],
    });
    expect(await response.json()).toMatchObject({
      answer: 'Alice triage steps.',
      citations: [{ sourceObjectId: 'alice-runbook', title: 'Triage runbook' }],
    });
  });

  it('passes full authorized content to the runner while displaying the short excerpt', async () => {
    const text = `${'Triage introduction. '.repeat(10)}Restart the service after checking the queue.`;
    const document = {
      id: 'runbook',
      folder: 'alice',
      title: 'Triage runbook',
      text,
      webViewLink: 'https://drive.fake.test/d/runbook',
    };
    const ports = await openDrive(() => ({
      status: 200,
      body: [
        document,
        { ...document, id: 'private', folder: 'bob', text: 'Private triage steps.' },
      ],
    }));
    ports.runner.run.mockResolvedValue({
      answer: 'Restart the service.',
      citedSourceIds: ['runbook'],
    });
    const response = await post(ports.stack, 'What are the triage runbook steps?');
    expect(response.status).toBe(200);
    expect(ports.runner.run).toHaveBeenCalledWith({
      question: 'What are the triage runbook steps?',
      sources: [expect.objectContaining({ id: 'runbook', text })],
    });
    expect(await response.json()).toMatchObject({
      answer: 'Restart the service.',
      citations: [{ sourceObjectId: 'runbook', excerpt: text.slice(0, 160) }],
    });
  });

  it('denies a removed user on the next request and audits the real decision', async () => {
    let groups = ['agent-users@company.example'];
    const ports = await open({ groups: () => Promise.resolve({ groups, observedAt: at }) });
    expect((await post(ports.stack)).status).toBe(200);
    groups = [];
    expect((await post(ports.stack)).status).toBe(403);
    expect(ports.search).toHaveBeenCalledTimes(1);
    expect(ports.submit).toHaveBeenCalledTimes(1);
    expect(ports.runner.run).not.toHaveBeenCalled();
    const decisions = ports.decision.mock.results.map((result) => result.value as PolicyDecision);
    expect(decisions[0]).toMatchObject({ effect: 'allow' });
    expect(decisions[1]).toMatchObject({
      effect: 'deny',
      failedClauses: ['active_org_membership', 'permitted_app_role'],
    });
    expect(ports.stack.audit.rows()).toMatchObject([
      { outcome: 'no_sources', policyDecisionId: decisions[0].decisionId },
      { outcome: 'denied', tool: null, policyDecisionId: decisions[1].decisionId },
    ]);
  });

  it('authorizes with the fake directory and denies after revocation', async () => {
    const directory = await listen(createDirectory(), 0);
    closers.push(directory.close);
    const groups = createGroupResolver({ baseUrl: directory.url });
    const ports = await open({ groups: (caller) => groups(caller.sub) }, () => new Date());
    expect((await post(ports.stack)).status).toBe(200);
    const revoked = await fetch(`${directory.url}/revocations`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sub: 'alice', group: 'agent-users@company.example' }),
    });
    expect(revoked.status).toBe(200);
    expect((await post(ports.stack)).status).toBe(403);
    expect(ports.search).toHaveBeenCalledTimes(1);
    expect(ports.stack.audit.rows()).toMatchObject([
      { outcome: 'no_sources' },
      { outcome: 'denied' },
    ]);
  });

  it.each(['answered', 'runner_failed'] as const)(
    'audits a fresh attempt after %s loses its ACK instead of pairing the old event with a new answer',
    async (outcome) => {
      const ledger = createMemoryLedgerPort(() => new Date(at));
      const append = ledger.append.bind(ledger);
      const lostAck = vi.spyOn(ledger, 'append').mockImplementationOnce(async (event) => {
        await append(event);
        throw new Error('lost acknowledgement');
      });
      let now = new Date(at);
      const ports = await open(
        { ledger, search: { search: () => Promise.resolve([citation]) } },
        () => now,
      );
      if (outcome === 'answered') {
        ports.runner.run.mockResolvedValueOnce({
          answer: 'original answer',
          citedSourceIds: ['source'],
        });
      } else {
        ports.runner.run.mockRejectedValueOnce(new RunnerError('original failure'));
      }
      ports.runner.run.mockResolvedValue({
        answer: 'regenerated answer',
        citedSourceIds: ['source'],
      });
      const requestId = randomUUID();
      expect((await post(ports.stack, 'question', requestId)).status).toBe(500);
      const persisted = await ledger.readOutbox(requestId);
      expect(persisted?.event.outcome).toBe(outcome);
      expect(ports.stack.audit.rows()).toEqual([]);
      now = new Date('2026-10-10T10:01:00.000Z');
      const response = await post(ports.stack, 'question', requestId);
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({ requestId, answer: 'regenerated answer' });
      const event = ports.stack.audit.rows()[0];
      const decisions = ports.decision.mock.results.map((result) => result.value as PolicyDecision);
      expect(event).toMatchObject({
        traceId: requestId.replaceAll('-', ''),
        taskId: persisted?.event.taskId,
        requestDigestSha256: persisted?.event.requestDigestSha256,
        agentPrincipal: 'agent:scripted-runner',
        policyDecisionId: decisions[1].decisionId,
        outcome: 'answered',
        occurredAt: now.toISOString(),
      });
      expect(event.eventId).not.toBe(requestId);
      expect(event.policyDecisionId).not.toBe(persisted?.event.policyDecisionId);
      expect(lostAck).toHaveBeenCalledTimes(2);
      expect(lostAck.mock.calls[1][0]).toEqual({ destination: 'audit', event });
      expect(await ledger.readOutbox(event.eventId)).toEqual({ destination: 'audit', event });
      expect(await ledger.readOutbox(requestId)).toEqual(persisted);
      expect(ports.runner.run).toHaveBeenCalledTimes(2);
      expect((await post(ports.stack, 'question', requestId)).status).toBe(409);
    },
  );

  it('records the current runner identity when a lost ACK retry changes runners', async () => {
    const model = await listen(
      () => ({
        status: 200,
        body: { candidates: [{ content: { parts: [{ text: 'original source answer' }] } }] },
      }),
      0,
    );
    closers.push(model.close);
    vi.stubEnv('AGENT_RUNNER', 'adk');
    vi.stubEnv('LLM_URL', model.url);
    const ledger = createMemoryLedgerPort(() => new Date(at));
    const append = ledger.append.bind(ledger);
    vi.spyOn(ledger, 'append').mockImplementationOnce(async (event) => {
      await append(event);
      throw new Error('lost acknowledgement');
    });
    const ports = await open({ ledger, search: { search: () => Promise.resolve([citation]) } });
    const requestId = randomUUID();
    expect((await post(ports.stack, 'question', requestId)).status).toBe(500);
    const original = await ledger.readOutbox(requestId);
    expect(original?.event.agentPrincipal).toBe('agent:adk-runner');
    vi.stubEnv('LLM_URL', undefined);
    ports.runner.run.mockResolvedValue({ answer: 'fallback answer', citedSourceIds: ['source'] });
    const response = await post(ports.stack, 'question', requestId);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ answer: 'fallback answer' });
    const event = ports.stack.audit.rows()[0];
    expect(event).toMatchObject({ agentPrincipal: 'agent:scripted-runner', outcome: 'answered' });
    expect(event.eventId).not.toBe(requestId);
    expect(await ledger.readOutbox(event.eventId)).toEqual({ destination: 'audit', event });
    expect(await ledger.readOutbox(requestId)).toEqual(original);
  });

  it.each([
    { question: 'changed question', user: 'alice' },
    { question: 'question', user: 'bob' },
  ])('rejects changed retry identity after a lost ACK: %j', async ({ question, user }) => {
    const ledger = createMemoryLedgerPort(() => new Date(at));
    const append = ledger.append.bind(ledger);
    vi.spyOn(ledger, 'append').mockImplementationOnce(async (event) => {
      await append(event);
      throw new Error('lost acknowledgement');
    });
    const ports = await open({ ledger });
    const requestId = randomUUID();
    expect((await post(ports.stack, 'question', requestId)).status).toBe(500);
    const original = await ledger.readOutbox(requestId);
    const response = await post(ports.stack, question, requestId, user);
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: 'conflict' });
    expect(await ledger.readOutbox(requestId)).toEqual(original);
    expect(ports.stack.audit.rows()).toEqual([]);
    expect(ports.groups).toHaveBeenCalledTimes(1);
    expect(ports.search).toHaveBeenCalledTimes(1);
  });

  it('reserves two concurrent retries after a lost ACK so only one new attempt returns an answer', async () => {
    const ledger = createMemoryLedgerPort(() => new Date(at));
    const append = ledger.append.bind(ledger);
    const submit = vi.spyOn(ledger, 'submit');
    vi.spyOn(ledger, 'append').mockImplementationOnce(async (event) => {
      await append(event);
      throw new Error('lost acknowledgement');
    });
    const ports = await open({ ledger, search: { search: () => Promise.resolve([citation]) } });
    ports.runner.run.mockResolvedValueOnce({ answer: 'original', citedSourceIds: ['source'] });
    const secondRoute = await startStack({
      now: () => new Date(at),
      audit: ports.stack.audit,
      runner: ports.runner,
      wire: {
        ledger,
        search: { search: ports.search },
        groups: ports.groups,
        policyInput: ports.policyInput,
      },
    });
    stacks.push(secondRoute);
    const requestId = randomUUID();
    expect((await post(ports.stack, 'question', requestId)).status).toBe(500);
    const original = await ledger.readOutbox(requestId);
    const entered = deferred();
    const release = deferred();
    ports.runner.run.mockImplementationOnce(async () => {
      entered.resolve();
      await release.promise;
      return { answer: 'retry', citedSourceIds: ['source'] };
    });
    const first = post(ports.stack, 'question', requestId);
    await entered.promise;
    try {
      const second = await post(secondRoute, 'question', requestId);
      expect(second.status).toBe(409);
      expect(await second.json()).toEqual({ error: 'conflict' });
    } finally {
      release.resolve();
    }
    const response = await first;
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ requestId, answer: 'retry' });
    expect(ports.runner.run).toHaveBeenCalledTimes(2);
    expect(ports.stack.audit.rows()).toHaveLength(1);
    const event = ports.stack.audit.rows()[0];
    expect(event.eventId).not.toBe(requestId);
    expect(event).toMatchObject({ outcome: 'answered', taskId: original?.event.taskId });
    expect(await ledger.readOutbox(event.eventId)).toEqual({ destination: 'audit', event });
    expect(await ledger.readOutbox(requestId)).toEqual(original);
    expect(await submit.mock.results[0].value).toEqual(await submit.mock.results[1].value);
  });

  it('reauthorizes a retry after a lost ACK and audits denial as a distinct attempt', async () => {
    const ledger = createMemoryLedgerPort(() => new Date(at));
    const append = ledger.append.bind(ledger);
    vi.spyOn(ledger, 'append').mockImplementationOnce(async (event) => {
      await append(event);
      throw new Error('lost acknowledgement');
    });
    const ports = await open({ ledger });
    const requestId = randomUUID();
    expect((await post(ports.stack, 'question', requestId)).status).toBe(500);
    const original = await ledger.readOutbox(requestId);
    ports.groups.mockResolvedValue({ groups: [], observedAt: at });
    const response = await post(ports.stack, 'question', requestId);
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: 'denied' });
    const decision = ports.decision.mock.results[1].value as PolicyDecision;
    expect(ports.stack.audit.rows()).toMatchObject([
      { outcome: 'denied', policyDecisionId: decision.decisionId, taskId: original?.event.taskId },
    ]);
    expect(ports.stack.audit.rows()[0].eventId).not.toBe(requestId);
    expect(await ledger.readOutbox(requestId)).toEqual(original);
    expect(ports.search).toHaveBeenCalledTimes(1);
  });

  it('denies a caller without Employee even if policy inputs claim the role', async () => {
    const ports = await open({
      groups: () =>
        Promise.resolve({ groups: ['agent-reviewers@company.example'], observedAt: at }),
      policyInput: () => Promise.resolve({ facts: { ...allowedFacts, permitted_app_role: true } }),
    });
    const response = await post(ports.stack);
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: 'denied' });
    const decision = ports.decision.mock.results[0].value as PolicyDecision;
    expect(decision).toMatchObject({ effect: 'deny', failedClauses: ['permitted_app_role'] });
    expect(ports.stack.audit.rows()).toMatchObject([
      { initiatorSubject: 'alice', outcome: 'denied', policyDecisionId: decision.decisionId },
    ]);
    expect(ports.search).not.toHaveBeenCalled();
    expect(ports.submit).not.toHaveBeenCalled();
  });

  it.each(Object.keys(allowedFacts) as (keyof PolicyFacts)[])(
    'denies when %s is unknown',
    async (clause) => {
      const facts = { ...allowedFacts };
      Reflect.deleteProperty(facts, clause);
      const ports = await open({ policyInput: () => Promise.resolve({ facts }) });
      expect((await post(ports.stack)).status).toBe(403);
      expect(ports.decision.mock.results[0].value).toMatchObject({
        effect: 'deny',
        failedClauses: [clause],
      });
      expect(ports.search).not.toHaveBeenCalled();
    },
  );

  it.each([
    { policyInput: undefined },
    { groups: () => Promise.reject(new Error('directory unavailable')) },
    { policyInput: () => Promise.reject(new Error('authority unavailable')) },
    {
      groups: () =>
        Promise.resolve({
          groups: ['agent-users@company.example'],
          observedAt: '1970-01-01T00:00:00.000Z',
        }),
    },
  ])('fails closed with unavailable or stale authorization inputs %j', async (patch) => {
    const ports = await open(patch);
    expect((await post(ports.stack)).status).toBe(403);
    expect(ports.stack.audit.rows()).toMatchObject([{ outcome: 'denied' }]);
    expect(ports.search).not.toHaveBeenCalled();
    expect(ports.submit).not.toHaveBeenCalled();
  });

  it('preserves each cited search timestamp after answer generation', async () => {
    const citations = ['first', 'second', 'unused'].map((id, index) => ({
      sourceObjectId: id,
      title: id,
      sourceUri: `https://drive.fake.test/d/${id}`,
      excerpt: `${id} text`,
      text: `${id} full text`,
      retrievedAt: `2026-10-10T09:0${index}:00.000Z`,
      etag: id,
      accessDecisionId: `access:${id}`,
    }));
    const ports = await open({ search: { search: () => Promise.resolve(citations) } });
    ports.runner.run.mockResolvedValue({ answer: 'answer', citedSourceIds: ['first', 'second'] });
    const response = await post(ports.stack);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      answer: 'answer',
      citations: citations.slice(0, 2).map((citation) => ({
        sourceObjectId: citation.sourceObjectId,
        retrievedAt: citation.retrievedAt,
      })),
    });
    expect(ports.stack.audit.rows()).toMatchObject([{ occurredAt: at }]);
  });

  it.each([undefined, '', '   '])('audits the fallback runner with LLM_URL=%j', async (url) => {
    vi.stubEnv('AGENT_RUNNER', 'adk');
    vi.stubEnv('LLM_URL', url);
    const ports = await open({
      search: {
        search: () =>
          Promise.resolve([
            {
              sourceObjectId: 'source',
              title: 'source',
              sourceUri: 'https://drive.fake.test/d/source',
              excerpt: 'source text',
              text: 'source full text',
              retrievedAt: at,
              etag: 'source',
              accessDecisionId: 'access',
            },
          ]),
      },
    });
    ports.runner.run.mockResolvedValue({ answer: 'fallback answer', citedSourceIds: ['source'] });
    const response = await post(ports.stack);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ answer: 'fallback answer' });
    expect(ports.runner.run).toHaveBeenCalledTimes(1);
    expect(ports.stack.audit.rows()).toMatchObject([{ agentPrincipal: 'agent:scripted-runner' }]);
  });

  it('binds policy and retrieval to the verified caller and the same snapshot', async () => {
    const ports = await open();
    expect((await post(ports.stack)).status).toBe(200);
    expect(ports.groups).toHaveBeenCalledTimes(1);
    expect(ports.policyInput.mock.calls[0]?.[0].assertion).toEqual(expect.any(String));
    expect(ports.policyInput).toHaveBeenCalledWith(
      expect.objectContaining({ sub: 'alice' }),
      expect.objectContaining({
        userSubject: 'alice',
        authorizedGroups: ['agent-users@company.example'],
        groupsObservedAt: at,
      }),
    );
    expect(ports.search).toHaveBeenCalledWith(ports.policyInput.mock.calls[0]?.[1], 'question');
  });
});

function post(stack: Stack, question = 'question', requestId = randomUUID(), user = 'alice') {
  return fetch(`${stack.iapUrl}/v1/ask`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-fake-user': user },
    body: JSON.stringify({ requestId, question }),
  });
}

const citation = {
  sourceObjectId: 'source',
  title: 'source',
  sourceUri: 'https://drive.fake.test/d/source',
  excerpt: 'source text',
  text: 'source full text',
  retrievedAt: at,
  etag: 'source',
  accessDecisionId: 'access',
};

function deferred() {
  let resolve = () => {};
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
