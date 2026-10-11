import { POLICY_CLAUSES } from '@agent-works/domain';
import { assert, constantFrom, property, record } from 'fast-check';
import { describe, expect, it } from 'vitest';

import { meanDecideMicroseconds } from './bench.js';

import { decide, whenAllowed } from './index.js';

import type { PolicyFacts } from './index.js';
import type { PolicyClause } from '@agent-works/domain';

const clauseList = [...POLICY_CLAUSES];

function allTrue(): Record<PolicyClause, boolean> {
  return {
    authenticated_actor: true,
    active_org_membership: true,
    permitted_app_role: true,
    approved_agent_and_skill_version: true,
    agent_has_tool_capability: true,
    user_or_service_has_resource_authority: true,
    source_system_allows_operation: true,
    data_classification_policy_allows: true,
    valid_approval_if_required: true,
    within_time_and_budget_bounds: true,
  };
}

function withFalse(clause: PolicyClause): Record<PolicyClause, boolean> {
  return { ...allTrue(), [clause]: false };
}

function expectedFailed(facts: PolicyFacts): PolicyClause[] {
  return POLICY_CLAUSES.filter((clause) => {
    // eslint-disable-next-line security/detect-object-injection
    return facts[clause] !== true;
  });
}

function matchesFacts(generated: PolicyFacts): boolean {
  const decision = decide({ facts: generated });
  const failed = expectedFailed(generated).join(' ');
  if (decision.effect === 'allow') return failed.length === 0;
  return decision.failedClauses.join(' ') === failed;
}

describe('decide', () => {
  it('allows when every clause holds and names policy version 1', () => {
    const decision = decide({ facts: allTrue() });
    expect(decision).toMatchObject({ effect: 'allow', policyVersion: '1' });
    expect(decision.decisionId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    );
    expect('failedClauses' in decision).toBe(false);
  });

  it.each(clauseList)('denies when %s is false', (clause) => {
    const decision = decide({ facts: withFalse(clause) });
    expect(decision).toMatchObject({ effect: 'deny', failedClauses: [clause] });
  });

  it('denies every clause when the fact source is down', () => {
    let ran = false;
    const decision = whenAllowed({ facts: {} }, () => {
      ran = true;
    });
    expect(decision).toMatchObject({ effect: 'deny', failedClauses: clauseList });
    expect(ran).toBe(false);
  });

  it('runs the tool only after every clause holds', () => {
    let ran = false;
    const decision = whenAllowed({ facts: allTrue() }, () => {
      ran = true;
    });
    expect(decision.effect).toBe('allow');
    expect(ran).toBe(true);
  });

  it('does not run a tool when approval is false', () => {
    let ran = false;
    const decision = whenAllowed({ facts: withFalse('valid_approval_if_required') }, () => {
      ran = true;
    });
    expect(decision).toMatchObject({
      effect: 'deny',
      failedClauses: ['valid_approval_if_required'],
    });
    expect(ran).toBe(false);
  });

  it('allows only when every generated clause is true', () => {
    const facts = record(
      {
        authenticated_actor: constantFrom(true, false),
        active_org_membership: constantFrom(true, false),
        permitted_app_role: constantFrom(true, false),
        approved_agent_and_skill_version: constantFrom(true, false),
        agent_has_tool_capability: constantFrom(true, false),
        user_or_service_has_resource_authority: constantFrom(true, false),
        source_system_allows_operation: constantFrom(true, false),
        data_classification_policy_allows: constantFrom(true, false),
        valid_approval_if_required: constantFrom(true, false),
        within_time_and_budget_bounds: constantFrom(true, false),
      },
      { requiredKeys: [] },
    );
    assert(property(facts, matchesFacts), { numRuns: 200 });
  });

  it('stays within 100 microseconds', () => {
    expect(meanDecideMicroseconds(allTrue(), 2000)).toBeLessThanOrEqual(100);
  });
});
