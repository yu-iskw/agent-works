import * as fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { authorityHash, authoritySubset, intersectAuthority } from './delegation-authority.js';

import type { RequestedGrant } from './delegation-authority.js';
import type { DelegationAuthority } from './delegation.js';
const base: DelegationAuthority = {
  subject: 'alice',
  agentPrincipal: 'agent:orchestrator',
  region: 'asia-northeast1',
  governanceZone: 'test',
  expiresAt: '2027-01-01T00:00:00.000Z',
  policyDecisionRef: 'policy-1',
  grants: [],
};
function requestedSubset(
  actual: readonly RequestedGrant[],
  requested: readonly RequestedGrant[],
): boolean {
  const wanted = new Set(requested.map((item) => JSON.stringify(item)));
  return actual.every((item) => wanted.has(JSON.stringify(item)));
}
const grant = fc.record({
  capability: fc.string({ minLength: 1, maxLength: 20 }),
  resource: fc.string({ minLength: 1, maxLength: 20 }),
});
describe('computed delegation authority', () => {
  it('is always a subset for arbitrary requested grants (1000 property runs)', () => {
    fc.assert(
      fc.property(
        fc.array(grant, { maxLength: 50 }),
        fc.array(grant, { maxLength: 50 }),
        (parentGrants, requested) => {
          const parent = { ...base, grants: parentGrants };
          const child = intersectAuthority(parent, requested);
          expect(authoritySubset(child, parent)).toBe(true);
          expect(requestedSubset(child.grants, requested)).toBe(true);
        },
      ),
      { numRuns: 1000 },
    );
  });
  it('does not amplify a capability by taking the cartesian product of resources', () => {
    const parent = {
      ...base,
      grants: [
        { capability: 'read', resource: 'public' },
        { capability: 'write', resource: 'draft' },
      ],
    };
    expect(
      intersectAuthority(parent, [{ capability: 'write', resource: 'public' }]).grants,
    ).toEqual([]);
  });
  it('canonicalizes reordered and duplicate grants for an auditable hash', () => {
    const a = { capability: 'read', resource: 'A' };
    const b = { capability: 'read', resource: 'B' };
    expect(authorityHash({ ...base, grants: [a, b, a] })).toBe(
      authorityHash({ ...base, grants: [b, a] }),
    );
  });
  it.each(['subject', 'agentPrincipal', 'region', 'governanceZone', 'policyDecisionRef'] as const)(
    'rejects changed identity field %s',
    (key) => {
      expect(authoritySubset({ ...base, [key]: 'other' }, base)).toBe(false);
    },
  );
  it('rejects an extended expiry even with identical grants', () => {
    expect(authoritySubset({ ...base, expiresAt: '2028-01-01T00:00:00.000Z' }, base)).toBe(false);
  });
});
