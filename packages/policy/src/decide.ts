import { randomUUID } from 'node:crypto';

import { POLICY_CLAUSES } from '@agent-works/domain';

import type { PolicyClause, PolicyDecision } from '@agent-works/domain';

export const POLICY_VERSION = '1';

export type PolicyFacts = { readonly [Clause in PolicyClause]?: boolean };

export type PolicyInput = {
  readonly facts: PolicyFacts;
};

function failedClauses(facts: PolicyFacts): PolicyClause[] {
  return POLICY_CLAUSES.filter((clause) => {
    // eslint-disable-next-line security/detect-object-injection
    return facts[clause] !== true;
  });
}

export function decide(input: PolicyInput): PolicyDecision {
  const failed = failedClauses(input.facts);
  const decisionId = randomUUID();
  if (failed.length === 0) {
    return { effect: 'allow', decisionId, policyVersion: POLICY_VERSION };
  }
  return { effect: 'deny', decisionId, policyVersion: POLICY_VERSION, failedClauses: failed };
}

export function whenAllowed(input: PolicyInput, tool: () => void): PolicyDecision {
  const decision = decide(input);
  switch (decision.effect) {
    case 'allow':
      tool();
      return decision;
    case 'deny':
      return decision;
    default: {
      const unexpected: never = decision;
      throw new Error(unexpected);
    }
  }
}
