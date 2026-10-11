import { POLICY_CLAUSES } from '@agent-works/domain';
import { describe, expect, it } from 'vitest';

import type { PolicyFacts, PolicyPort } from './policy-port.js';

function allTrue(): PolicyFacts {
  return Object.fromEntries(POLICY_CLAUSES.map((clause) => [clause, true]));
}

export function policyPortContract(create: () => PolicyPort): void {
  describe('PolicyPort', () => {
    it('allows when every clause holds', async () => {
      const decision = await create().decide({ facts: allTrue() });
      expect(decision.effect).toBe('allow');
      expect(decision.policyVersion).toBe('memory');
    });

    it('denies the clause that is false', async () => {
      const decision = await create().decide({
        facts: { ...allTrue(), authenticated_actor: false },
      });
      expect(decision).toMatchObject({
        effect: 'deny',
        failedClauses: ['authenticated_actor'],
      });
    });

    it('denies every clause when no fact is present', async () => {
      const decision = await create().decide({ facts: {} });
      expect(decision).toMatchObject({ effect: 'deny', failedClauses: [...POLICY_CLAUSES] });
    });
  });
}
