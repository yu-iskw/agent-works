import { POLICY_CLAUSES, ticketCreateManifest } from '@agent-works/domain';

import type { AuthorityResolver } from './authority.js';
import type { PolicyFacts } from '@agent-works/policy';

const allClauses: PolicyFacts = Object.fromEntries(POLICY_CLAUSES.map((clause) => [clause, true]));

/**
 * Test-only resolver that trusts the claimed actor and resource and grants the tool's workload
 * capability. Facts default to every clause true. Production wiring never uses it.
 */
export function trustedTestResolver(
  facts: () => PolicyFacts = () => allClauses,
): AuthorityResolver {
  return (request) =>
    Promise.resolve({
      kind: 'granted',
      subject: request.claimedActor,
      authority: {
        kind: 'userDelegated',
        scopes: [ticketCreateManifest.spec.permissions.workloadCapability],
        resourceConstraint: request.targetResource,
        expiresAt: '2099-01-01T00:00:00.000Z',
        auditRef: 'test-authority',
      },
      facts: facts(),
    });
}
