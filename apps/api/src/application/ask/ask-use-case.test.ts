import { RunnerError } from '@agent-works/agent-runtime/port';
import { decide } from '@agent-works/policy';
import { describe, expect, it, vi } from 'vitest';

import { createMemoryAuditLog } from '../../audit/write.js';
import { createMemoryLedgerPort } from '../../ports/memory/ledger-port.js';

import { ask } from './ask-use-case.js';

import type { AskUseCaseDeps } from './ask-use-case.js';
import type { AskWire } from './ports.js';
import type { Caller } from '../../auth/iap.js';
import type { SourceDocument } from '../../retrieval/drive-port.js';
import type { PolicyFacts } from '@agent-works/policy';

const at = '2026-10-10T10:00:00.000Z';
const alice = { sub: 'alice', assertion: 'assertion' } as Caller;
const request = { requestId: '7f9c2ba4-e88f-4c1a-9d5e-3c2b1a0f9e8d', question: 'q' };
const source: SourceDocument = {
  id: 'runbook',
  title: 'Runbook',
  text: 'Steps.',
  uri: 'https://drive.fake.test/d/runbook',
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

function deps(patch: Partial<AskUseCaseDeps> = {}) {
  const audit = createMemoryAuditLog();
  const all: AskUseCaseDeps = {
    runner: { run: () => Promise.resolve({ answer: 'Do it.', citedSourceIds: [source.id] }) },
    agentPrincipal: 'agent:test',
    retrieval: { retrieve: () => Promise.resolve([source]) },
    audit,
    policy: decide,
    clock: () => new Date(at),
    ...patch,
  };
  return { all, audit };
}

function wire(patch: Partial<AskWire> = {}): AskWire {
  return {
    search: { search: () => Promise.resolve([]) },
    ledger: createMemoryLedgerPort(() => new Date(at)),
    groups: () => Promise.resolve({ groups: ['agent-users@company.example'], observedAt: at }),
    policyInput: () => Promise.resolve({ facts: allowedFacts }),
    ...patch,
  };
}

describe('ask use case', () => {
  it('answers with domain citations and audits the runner identity', async () => {
    const { all, audit } = deps();
    expect(await ask(all, alice, request)).toEqual({
      kind: 'answered',
      answer: 'Do it.',
      citations: [
        {
          sourceObjectId: source.id,
          title: source.title,
          sourceUri: source.uri,
          retrievedAt: at,
          excerpt: source.text,
        },
      ],
    });
    expect(audit.rows()).toMatchObject([{ outcome: 'answered', agentPrincipal: 'agent:test' }]);
  });

  it('maps a RunnerError to runner_failed and still audits', async () => {
    const { all, audit } = deps({
      runner: { run: () => Promise.reject(new RunnerError('model')) },
    });
    expect(await ask(all, alice, request)).toEqual({ kind: 'runner_failed' });
    expect(audit.rows()).toMatchObject([{ outcome: 'runner_failed' }]);
  });

  it('runs once per request id and reports the repeat as a conflict', async () => {
    const run = vi.fn(() => Promise.resolve({ answer: 'Do it.', citedSourceIds: [] }));
    const { all } = deps({ runner: { run } });
    await ask(all, alice, request);
    expect(await ask(all, alice, request)).toEqual({ kind: 'conflict' });
    expect(run).toHaveBeenCalledTimes(1);
  });

  it('asks the policy port and stops at deny before searching', async () => {
    const search = vi.fn(() => Promise.resolve([]));
    const policy = vi.fn(decide);
    const { all, audit } = deps({
      policy,
      wire: wire({
        search: { search },
        groups: () => Promise.resolve({ groups: [], observedAt: at }),
      }),
    });
    expect(await ask(all, alice, request)).toEqual({ kind: 'denied' });
    expect(policy).toHaveBeenCalledTimes(1);
    expect(search).not.toHaveBeenCalled();
    expect(audit.rows()).toMatchObject([{ outcome: 'denied', tool: null }]);
  });

  it('reads the clock for authorization and again for the audit event', async () => {
    const clock = vi.fn(() => new Date(at));
    const { all } = deps({ clock, wire: wire() });
    expect(await ask(all, alice, request)).toEqual({ kind: 'no_sources' });
    expect(clock).toHaveBeenCalledTimes(2);
  });

  it('reports a changed retry as a conflict without running', async () => {
    const shared = wire();
    await ask(deps({ wire: shared }).all, alice, request);
    const run = vi.fn();
    const retry = deps({ runner: { run }, wire: shared });
    expect(await ask(retry.all, alice, { ...request, question: 'changed' })).toEqual({
      kind: 'conflict',
    });
    expect(run).not.toHaveBeenCalled();
  });
});
