import { randomUUID } from 'node:crypto';

import { POLICY_CLAUSES, policyDecisionSchema } from '@agent-works/domain';

import type { PolicyFacts, PolicyInput, PolicyPort } from '../policy-port.js';
import type { PolicyClause } from '@agent-works/domain';

const policyVersion = 'memory';

function holds(facts: PolicyFacts, clause: PolicyClause): boolean {
  switch (clause) {
    case 'authenticated_actor':
      return facts.authenticated_actor === true;
    case 'active_org_membership':
      return facts.active_org_membership === true;
    case 'permitted_app_role':
      return facts.permitted_app_role === true;
    case 'approved_agent_and_skill_version':
      return facts.approved_agent_and_skill_version === true;
    case 'agent_has_tool_capability':
      return facts.agent_has_tool_capability === true;
    case 'user_or_service_has_resource_authority':
      return facts.user_or_service_has_resource_authority === true;
    case 'source_system_allows_operation':
      return facts.source_system_allows_operation === true;
    case 'data_classification_policy_allows':
      return facts.data_classification_policy_allows === true;
    case 'valid_approval_if_required':
      return facts.valid_approval_if_required === true;
    case 'within_time_and_budget_bounds':
      return facts.within_time_and_budget_bounds === true;
    default: {
      const exhaustive: never = clause;
      return exhaustive;
    }
  }
}

export function createMemoryPolicyPort(): PolicyPort {
  return {
    decide(input: PolicyInput) {
      const failedClauses = POLICY_CLAUSES.filter((clause) => !holds(input.facts, clause));
      if (failedClauses.length === 0) {
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
          failedClauses,
        }),
      );
    },
  };
}
