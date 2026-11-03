import * as z from 'zod';

import { budgetLimitsSchema } from './budget.js';

import type { Authority } from './authority.js';
import type { BudgetLimits } from './budget.js';
import type { DelegationAuthority } from './delegation.js';

/**
 * AGT-00 frozen logical contract for a standing grant. It is a view over the canonical types, not
 * a second authority system: `permissions` become `DelegationAuthority.grants`, the call-time
 * answer is an `Authority`, and `policyRevision`/`auditRef` are `policyDecisionRef`/`auditRef`.
 * A grant lives in the database of the segment that issued it, so it has no workspace id.
 * Current source access, membership and consent are checked separately on each call; a grant is
 * never proof of them.
 */
export const STANDING_GRANT_CONTRACT_VERSION = 'teamwork.grant.v1';

const label = z.string().min(1).max(200);
const at = z.iso.datetime();
const count = z.number().int().nonnegative().safe();

/** Exact action and resource pair, as in `DelegationAuthority`; no wildcards, no cartesian products. */
const grantPermissionSchema = z.strictObject({ action: label, resource: label });
type GrantPermission = z.infer<typeof grantPermissionSchema>;

const grantScheduleSchema = z.strictObject({
  allowed: z.boolean(),
  /** Shortest interval between runs of a routine this grant authorises. */
  minIntervalSeconds: count,
  /** Longest a routine may stay active after activation. */
  maxLifetimeSeconds: count,
  maxActiveRoutines: count,
});
type GrantSchedule = z.infer<typeof grantScheduleSchema>;

const grantLimitsSchema = z.strictObject({
  maxConcurrency: count,
  maxFanOut: count,
  budget: budgetLimitsSchema,
});

const grantRevocationSchema = z.discriminatedUnion('status', [
  z.strictObject({ status: z.literal('active') }),
  z.strictObject({ status: z.literal('revoked'), revokedAt: at, revokedBy: label }),
]);

export const standingGrantSchema = z
  .strictObject({
    grantId: label,
    /** A human or admin for a root grant; the parent grant's grantee for a child. */
    issuer: label,
    /** The human on whose authority the chain rests. It never changes down the chain. */
    sponsor: label,
    grantee: z.strictObject({ botId: label, botVersion: z.number().int().positive() }),
    permissions: z.array(grantPermissionSchema).min(1).max(256),
    issuedAt: at,
    expiresAt: at,
    revocation: grantRevocationSchema,
    parentGrantId: label.nullable(),
    /** 0 for a root grant. */
    depth: count,
    /** Absolute cap for the whole chain. */
    maxDepth: count,
    schedule: grantScheduleSchema,
    limits: grantLimitsSchema,
    policyRevision: label,
    auditRef: label,
  })
  .refine((grant) => Date.parse(grant.expiresAt) > Date.parse(grant.issuedAt), {
    path: ['expiresAt'],
    message: 'expiresAt must be after issuedAt',
  })
  .refine((grant) => grant.depth <= grant.maxDepth, {
    path: ['depth'],
    message: 'depth exceeds maxDepth',
  })
  .refine((grant) => (grant.parentGrantId === null) === (grant.depth === 0), {
    path: ['parentGrantId'],
    message: 'only a root grant has depth 0 and no parent',
  });
export type StandingGrant = z.infer<typeof standingGrantSchema>;

/** Where a deployment, not the grant, fixes `DelegationAuthority`'s region and zone. */
export type GrantDeployment = { readonly region: string; readonly governanceZone: string };

const pairKey = (permission: GrantPermission): string =>
  JSON.stringify([permission.action, permission.resource]);

export function toDelegationAuthority(
  grant: StandingGrant,
  deployment: GrantDeployment,
): DelegationAuthority {
  return {
    subject: grant.sponsor,
    agentPrincipal: `bot:${grant.grantee.botId}@${grant.grantee.botVersion}`,
    governanceZone: deployment.governanceZone,
    region: deployment.region,
    grants: grant.permissions.map(({ action, resource }) => ({ capability: action, resource })),
    expiresAt: grant.expiresAt,
    policyDecisionRef: grant.policyRevision,
  };
}

export type GrantUse = { readonly action: string; readonly resource: string; readonly now: string };

/** Why a grant cannot back a call. Absent state denies; this never reads a snapshot of access. */
export type GrantDenial = 'not_yet_valid' | 'expired' | 'revoked' | 'no_matching_permission';

/** The canonical `Authority` for one call, or the reason there is none. */
export function authorityForCall(
  grant: StandingGrant,
  use: GrantUse,
): { readonly authority: Authority } | { readonly denied: GrantDenial } {
  const now = Date.parse(use.now);
  if (grant.revocation.status === 'revoked') return { denied: 'revoked' };
  if (now < Date.parse(grant.issuedAt)) return { denied: 'not_yet_valid' };
  if (now >= Date.parse(grant.expiresAt)) return { denied: 'expired' };
  if (!grant.permissions.some((p) => p.action === use.action && p.resource === use.resource))
    return { denied: 'no_matching_permission' };
  return {
    authority: {
      kind: 'userDelegated',
      scopes: [use.action],
      resourceConstraint: use.resource,
      expiresAt: grant.expiresAt,
      auditRef: grant.auditRef,
    },
  };
}

/** A child is usable only while every ancestor is: revoking a sponsor's root stops the chain. */
export function chainUsable(chain: readonly StandingGrant[], now: string): boolean {
  return chain.every(
    (grant) =>
      grant.revocation.status === 'active' &&
      Date.parse(grant.issuedAt) <= Date.parse(now) &&
      Date.parse(now) < Date.parse(grant.expiresAt),
  );
}

export type ChildGrantRequest = Omit<
  StandingGrant,
  'issuer' | 'sponsor' | 'parentGrantId' | 'depth' | 'revocation' | 'policyRevision'
>;

export type ChildDenial =
  | 'parent_unusable'
  | 'permission_widened'
  | 'expiry_widened'
  | 'issued_before_parent'
  | 'depth_exceeded'
  | 'max_depth_widened'
  | 'schedule_widened'
  | 'concurrency_widened'
  | 'fan_out_widened'
  | 'budget_widened';

const within = (child: number, parent: number): boolean => child <= parent;

function budgetWithin(child: BudgetLimits, parent: BudgetLimits): boolean {
  return (
    within(child.estimatedCostMicros, parent.estimatedCostMicros) &&
    within(child.inferenceSteps, parent.inferenceSteps) &&
    within(child.parallelism, parent.parallelism)
  );
}

function scheduleWithin(child: GrantSchedule, parent: GrantSchedule): boolean {
  if (!child.allowed) return true;
  return (
    parent.allowed &&
    child.minIntervalSeconds >= parent.minIntervalSeconds &&
    within(child.maxLifetimeSeconds, parent.maxLifetimeSeconds) &&
    within(child.maxActiveRoutines, parent.maxActiveRoutines)
  );
}

/**
 * Intersection-only issuance. The result is the request itself, accepted only when it is no wider
 * than the parent on every axis; it is never widened or silently trimmed. Sponsor, issuer,
 * depth, revocation and policy revision are set from the parent, so a caller cannot choose them.
 */
export function deriveChildGrant(
  parent: StandingGrant,
  request: ChildGrantRequest,
  now: string,
):
  | { readonly ok: true; readonly grant: StandingGrant }
  | { readonly ok: false; readonly reasons: readonly ChildDenial[] } {
  const reasons: ChildDenial[] = [];
  if (!chainUsable([parent], now)) reasons.push('parent_unusable');
  const parentPairs = new Set(parent.permissions.map(pairKey));
  if (!request.permissions.every((p) => parentPairs.has(pairKey(p))))
    reasons.push('permission_widened');
  if (Date.parse(request.expiresAt) > Date.parse(parent.expiresAt)) reasons.push('expiry_widened');
  if (Date.parse(request.issuedAt) < Date.parse(parent.issuedAt))
    reasons.push('issued_before_parent');
  if (request.maxDepth > parent.maxDepth) reasons.push('max_depth_widened');
  if (parent.depth + 1 > Math.min(parent.maxDepth, request.maxDepth))
    reasons.push('depth_exceeded');
  if (!scheduleWithin(request.schedule, parent.schedule)) reasons.push('schedule_widened');
  if (!within(request.limits.maxConcurrency, parent.limits.maxConcurrency))
    reasons.push('concurrency_widened');
  if (!within(request.limits.maxFanOut, parent.limits.maxFanOut)) reasons.push('fan_out_widened');
  if (!budgetWithin(request.limits.budget, parent.limits.budget)) reasons.push('budget_widened');
  if (reasons.length > 0) return { ok: false, reasons };
  const grant: StandingGrant = standingGrantSchema.parse({
    ...request,
    issuer: `bot:${parent.grantee.botId}@${parent.grantee.botVersion}`,
    sponsor: parent.sponsor,
    parentGrantId: parent.grantId,
    depth: parent.depth + 1,
    revocation: { status: 'active' },
    policyRevision: parent.policyRevision,
  });
  return { ok: true, grant };
}
