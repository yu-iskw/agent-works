import { describe, expect, it } from 'vitest';

import { policyDecisionSchema } from './policy.js';

const allow = {
  effect: 'allow' as const,
  decisionId: '00000000-0000-4000-8000-000000000001',
  policyVersion: 'v1',
};

describe('policy decision', () => {
  it('parses an allow decision', () => {
    expect(policyDecisionSchema.parse(allow)).toEqual(allow);
  });

  it('rejects an allow decision that lists failed clauses', () => {
    expect(
      policyDecisionSchema.safeParse({ ...allow, failedClauses: ['authenticated_actor'] }).success,
    ).toBe(false);
  });

  it('rejects a deny decision with no failed clause', () => {
    expect(
      policyDecisionSchema.safeParse({
        effect: 'deny',
        decisionId: allow.decisionId,
        policyVersion: 'v1',
        failedClauses: [],
      }).success,
    ).toBe(false);
  });
});
