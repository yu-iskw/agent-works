import type { PolicyClause, PolicyDecision } from '@agent-works/domain';

export type PolicyFacts = { readonly [Clause in PolicyClause]?: boolean };

export type PolicyInput = {
  readonly facts: PolicyFacts;
};

export interface PolicyPort {
  decide(input: PolicyInput): Promise<PolicyDecision>;
}
