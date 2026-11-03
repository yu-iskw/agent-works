import { authorityForCall, chainUsable } from '@agent-works/domain/standing-grant-contract';

import type { GrantActivation } from './lifecycle.js';
import type { GrantStore } from './store.js';
import type { AuthorityRequest, AuthorityResolver } from '../broker/authority.js';
import type { Authority } from '@agent-works/domain';
import type { GrantDenial, StandingGrant } from '@agent-works/domain/standing-grant-contract';
import type { PolicyFacts } from '@agent-works/policy';

type StandingDenial = GrantDenial | 'activation_off' | 'grant_not_found' | 'ancestor_unusable';

export type StandingAuthority =
  | { readonly kind: 'granted'; readonly sponsor: string; readonly authority: Authority }
  | { readonly kind: 'denied'; readonly reason: StandingDenial };

export type StandingUse = {
  readonly grantId: string;
  readonly action: string;
  readonly resource: string;
};

/**
 * The call-time answer for one sensitive call under a standing grant. It reads the chain from the
 * store on every call, so a revocation, expiry or ancestor change takes effect for work that was
 * queued before it. Absent or unreadable state denies (a store error is thrown to the caller, which
 * the broker turns into a retryable failure). The grant is never proof of current membership or
 * source access; those facts come from the caller's policy facts.
 */
export async function resolveStandingAuthority(
  deps: {
    readonly store: GrantStore;
    readonly activation: GrantActivation;
    readonly now: () => Date;
  },
  use: StandingUse,
): Promise<StandingAuthority> {
  if (!deps.activation.enabled) return { kind: 'denied', reason: 'activation_off' };
  const chain = await deps.store.chain(use.grantId);
  const grant = chain.at(0);
  if (grant === undefined) return { kind: 'denied', reason: 'grant_not_found' };
  const now = deps.now().toISOString();
  const answer = authorityForCall(grant, { action: use.action, resource: use.resource, now });
  if ('denied' in answer) return { kind: 'denied', reason: answer.denied };
  if (!chainIntact(chain) || !chainUsable(chain, now)) {
    return { kind: 'denied', reason: 'ancestor_unusable' };
  }
  const earliest = Math.min(...chain.map((link) => Date.parse(link.expiresAt)));
  return {
    kind: 'granted',
    sponsor: grant.sponsor,
    authority: { ...answer.authority, expiresAt: new Date(earliest).toISOString() },
  };
}

/** The chain must reach a root, keep one sponsor, and never be missing a link. */
function chainIntact(chain: readonly StandingGrant[]): boolean {
  const root = chain.at(-1);
  if (root === undefined || root.parentGrantId !== null) return false;
  return chain.every(
    (link, index) =>
      link.sponsor === root.sponsor &&
      (index === chain.length - 1 || link.parentGrantId === chain[index + 1]?.grantId),
  );
}

type StandingBinding = { readonly grantId: string; readonly action: string };

export type StandingResolverDeps = {
  readonly store: GrantStore;
  readonly activation: GrantActivation;
  readonly now: () => Date;
  /** Which grant backs this call and which action it exercises. Server state, not a claim. */
  readonly bindingFor: (request: AuthorityRequest) => Promise<StandingBinding | undefined>;
  /** Policy facts for the sponsor now: membership, role, source access. Throw if unreadable. */
  readonly facts: (sponsor: string, request: AuthorityRequest) => Promise<PolicyFacts>;
};

/**
 * Adapter for the broker's `AuthorityResolver`. The broker already denies when the resolved subject
 * is not the claimed actor, so a call run for anyone but the sponsor is refused. It omits
 * `delegation`: `authoritySubset` requires equal agent principals, which a child grant's grantee
 * does not have; the lifecycle store enforced the parent/child subset at issue time.
 */
export function createStandingAuthorityResolver(deps: StandingResolverDeps): AuthorityResolver {
  return async (request) => {
    const binding = await deps.bindingFor(request);
    if (binding === undefined) return { kind: 'denied', reason: 'unknown_actor' };
    const result = await resolveStandingAuthority(deps, {
      grantId: binding.grantId,
      action: binding.action,
      resource: request.targetResource,
    });
    if (result.kind === 'denied') {
      const unknown = result.reason === 'activation_off' || result.reason === 'grant_not_found';
      return { kind: 'denied', reason: unknown ? 'unknown_actor' : 'revoked' };
    }
    return {
      kind: 'granted',
      subject: result.sponsor,
      authority: result.authority,
      facts: await deps.facts(result.sponsor, request),
    };
  };
}
