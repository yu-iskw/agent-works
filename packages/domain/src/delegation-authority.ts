import { canonicalPayloadSha256 } from './canonical-hash.js';
import { delegationAuthoritySchema } from './delegation.js';

import type { DelegationAuthority } from './delegation.js';
export type RequestedGrant = { readonly capability: string; readonly resource: string };
function grantKey(grant: RequestedGrant): string {
  return JSON.stringify([grant.capability, grant.resource]);
}
export function intersectAuthority(
  parentInput: DelegationAuthority,
  requested: readonly RequestedGrant[],
): DelegationAuthority {
  const parent = delegationAuthoritySchema.parse(parentInput);
  const wanted = new Set(requested.map(grantKey));
  const grants = new Map(
    parent.grants
      .filter((grant) => wanted.has(grantKey(grant)))
      .map((grant) => [grantKey(grant), grant]),
  );
  return {
    ...parent,
    grants: [...grants.values()].sort((a, b) => grantKey(a).localeCompare(grantKey(b))),
  };
}
export function authoritySubset(child: DelegationAuthority, parent: DelegationAuthority): boolean {
  const grants = new Set(parent.grants.map(grantKey));
  return (
    child.subject === parent.subject &&
    child.agentPrincipal === parent.agentPrincipal &&
    child.region === parent.region &&
    child.governanceZone === parent.governanceZone &&
    child.policyDecisionRef === parent.policyDecisionRef &&
    Date.parse(child.expiresAt) <= Date.parse(parent.expiresAt) &&
    child.grants.every((grant) => grants.has(grantKey(grant)))
  );
}
export function authorityHash(authority: DelegationAuthority): string {
  const normalized = intersectAuthority(authority, authority.grants);
  return canonicalPayloadSha256(normalized);
}
