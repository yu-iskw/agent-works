import { randomUUID } from 'node:crypto';

import * as policy from '@agent-works/policy';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createMemoryLedgerPort } from '../ports/memory/ledger-port.js';
import { startStack } from '../testing/stack.js';

import type { AskDeps } from './ask.js';
import type { Stack } from '../testing/stack.js';
import type { PolicyDecision } from '@agent-works/domain';
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

  afterEach(async () => {
    for (const stack of stacks.splice(0)) await stack.close();
    vi.restoreAllMocks();
  });

  async function open(patch: Partial<NonNullable<AskDeps['wire']>> = {}) {
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
      now: () => new Date(at),
      runner,
      wire: { search: { search }, ledger, groups, policyInput, ...patch },
    });
    stacks.push(stack);
    return { stack, search, runner, submit, decision, policyInput, groups };
  }

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

function post(stack: Stack) {
  return fetch(`${stack.iapUrl}/v1/ask`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-fake-user': 'alice' },
    body: JSON.stringify({ requestId: randomUUID(), question: 'question' }),
  });
}
