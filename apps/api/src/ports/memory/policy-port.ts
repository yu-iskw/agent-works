import { randomUUID } from 'node:crypto';

import { POLICY_CLAUSES, policyDecisionSchema } from '@agent-works/domain';

import type { PolicyFacts, PolicyInput, PolicyPort } from '../policy-port.js';
import type { PolicyClause } from '@agent-works/domain';

const policyVersion = 'memory';

function failedClauses(facts: PolicyFacts): PolicyClause[] {
  return POLICY_CLAUSES.filter((clause) => {
    // eslint-disable-next-line security/detect-object-injection
    return facts[clause] !== true;
  });
}

export function createMemoryPolicyPort(): PolicyPort {
  return {
    decide(input: PolicyInput) {
      const failed = failedClauses(input.facts);
      if (failed.length === 0) {
        return Promise.resolve(
          policyDecisionSchema.parse({
            effect: 'allow',
            decisionId: randomUUID(),
            policyVersion,
          }),
        );
      }
      return Promise.resolve(
        policyDecisionSchema.parse({
          effect: 'deny',
          decisionId: randomUUID(),
          policyVersion,
          failedClauses: failed,
        }),
      );
    },
  };
}
