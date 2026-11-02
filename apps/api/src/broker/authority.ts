import { authoritySchema, ticketCreateManifest } from '@agent-works/domain';
import { delegationAuthoritySchema } from '@agent-works/domain/delegation';
import { authoritySubset } from '@agent-works/domain/delegation-authority';

import type { Authority } from '@agent-works/domain';
import type { DelegationAuthority } from '@agent-works/domain/delegation';
import type { PolicyFacts } from '@agent-works/policy';

/** What the broker asks the trusted server side about. The caller's claims are inputs to verify, never answers. */
export type AuthorityRequest = {
  readonly claimedActor: string;
  readonly taskId: string;
  readonly stepId: string;
  readonly toolRef: string;
  readonly targetResource: string;
  readonly approvalId: string;
  readonly signal?: AbortSignal;
};

type AuthorityDenialReason =
  'revoked' | 'membership_removed' | 'connector_disabled' | 'unknown_actor';

/**
 * The server-derived answer. `authority` is the canonical domain Authority, checked here against the
 * call. `delegation` is present for a child task and must be a subset of its parent.
 */
export type AuthorityResolution =
  | {
      readonly kind: 'granted';
      readonly subject: string;
      readonly authority: Authority;
      readonly facts: PolicyFacts;
      readonly delegation?: {
        readonly child: DelegationAuthority;
        readonly parent: DelegationAuthority;
      };
    }
  | { readonly kind: 'denied'; readonly reason: AuthorityDenialReason };

/**
 * Resolves authority from trusted server state (session, directory, grants, installations).
 * It must throw when that state cannot be read; the broker then fails closed and retryable.
 */
export type AuthorityResolver = (request: AuthorityRequest) => Promise<AuthorityResolution>;

export type AuthorityVerdict =
  | { readonly ok: true; readonly subject: string; readonly facts: PolicyFacts }
  | { readonly ok: false; readonly code: 'AUTHORITY_DENIED' | 'AUTHORITY_UNAVAILABLE' };

const denied = { ok: false, code: 'AUTHORITY_DENIED' } as const;
const unavailable = { ok: false, code: 'AUTHORITY_UNAVAILABLE' } as const;

const { workloadCapability, userAuthority } = ticketCreateManifest.spec.permissions;
// eslint-disable-next-line security/detect-object-injection
const requiredKind = {
  delegated: 'userDelegated',
  approvedService: 'approvedServiceWorkflow',
}[userAuthority];

export async function resolveAuthority(
  resolver: AuthorityResolver,
  request: AuthorityRequest,
  now: Date,
): Promise<AuthorityVerdict> {
  let resolution: AuthorityResolution;
  try {
    resolution = await resolver(request);
  } catch {
    request.signal?.throwIfAborted();
    return unavailable;
  }
  return judgeAuthority(resolution, request, now);
}

function judgeAuthority(
  resolution: AuthorityResolution,
  request: AuthorityRequest,
  now: Date,
): AuthorityVerdict {
  if (resolution.kind !== 'granted') return denied;
  const parsed = authoritySchema.safeParse(resolution.authority);
  if (!parsed.success) return denied;
  const authority = parsed.data;
  if (resolution.subject.length === 0 || resolution.subject !== request.claimedActor) return denied;
  if (Date.parse(authority.expiresAt) <= now.getTime()) return denied;
  if (authority.kind !== requiredKind) return denied;
  if (!authority.scopes.includes(workloadCapability)) return denied;
  if (authority.resourceConstraint !== request.targetResource) return denied;
  if (!delegationHolds(resolution, request, now)) return denied;
  return { ok: true, subject: resolution.subject, facts: resolution.facts };
}

function delegationHolds(
  resolution: Extract<AuthorityResolution, { kind: 'granted' }>,
  request: AuthorityRequest,
  now: Date,
): boolean {
  if (resolution.delegation === undefined) return true;
  const child = delegationAuthoritySchema.safeParse(resolution.delegation.child);
  const parent = delegationAuthoritySchema.safeParse(resolution.delegation.parent);
  if (!child.success || !parent.success) return false;
  return (
    child.data.subject === resolution.subject &&
    Date.parse(child.data.expiresAt) > now.getTime() &&
    authoritySubset(child.data, parent.data) &&
    child.data.grants.some(
      (grant) =>
        grant.capability === workloadCapability && grant.resource === request.targetResource,
    )
  );
}
