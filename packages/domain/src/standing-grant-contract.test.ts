/* eslint-disable max-nested-callbacks, sonarjs/cyclomatic-complexity -- property test mirrors every axis */
import * as fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { authoritySchema } from './authority.js';
import { authoritySubset } from './delegation-authority.js';
import { delegationAuthoritySchema } from './delegation.js';
import {
  authorityForCall,
  chainUsable,
  STANDING_GRANT_CONTRACT_VERSION,
  deriveChildGrant,
  standingGrantSchema,
  toDelegationAuthority,
} from './standing-grant-contract.js';
import {
  GRANT_DEPLOYMENT,
  GRANT_NOW,
  childRequestFixture,
  rootGrantFixture,
} from './standing-grant-fixtures.js';

import type { ChildGrantRequest, StandingGrant } from './standing-grant-contract.js';

const root = rootGrantFixture;

function child(overrides: Partial<ChildGrantRequest> = {}) {
  return deriveChildGrant(root, { ...childRequestFixture, ...overrides }, GRANT_NOW);
}
function denials(overrides: Partial<ChildGrantRequest>) {
  const result = child(overrides);
  return result.ok ? [] : result.reasons;
}

describe('standing grant mapped onto canonical authority', () => {
  it('parses the fixture and rejects unknown fields, bad dates and an inconsistent chain', () => {
    expect(standingGrantSchema.safeParse(root).success).toBe(true);
    expect(standingGrantSchema.safeParse({ ...root, workspaceId: 'w' }).success).toBe(false);
    expect(standingGrantSchema.safeParse({ ...root, expiresAt: root.issuedAt }).success).toBe(
      false,
    );
    expect(standingGrantSchema.safeParse({ ...root, depth: 3 }).success).toBe(false);
    expect(standingGrantSchema.safeParse({ ...root, parentGrantId: 'x' }).success).toBe(false);
    expect(standingGrantSchema.safeParse({ ...root, permissions: [] }).success).toBe(false);
  });

  it('projects to a valid DelegationAuthority carrying sponsor, policy revision and expiry', () => {
    const authority = toDelegationAuthority(root, GRANT_DEPLOYMENT);
    expect(delegationAuthoritySchema.safeParse(authority).success).toBe(true);
    expect(authority.subject).toBe(root.sponsor);
    expect(authority.policyDecisionRef).toBe(root.policyRevision);
    expect(authority.expiresAt).toBe(root.expiresAt);
    expect(authority.grants).toHaveLength(root.permissions.length);
  });

  it('yields a canonical Authority for one matching call and nothing otherwise', () => {
    const use = { action: 'drive.read', resource: 'drive_research', now: GRANT_NOW };
    const result = authorityForCall(root, use);
    if (!('authority' in result)) throw new Error('expected authority');
    expect(authoritySchema.safeParse(result.authority).success).toBe(true);
    expect(result.authority).toMatchObject({
      kind: 'userDelegated',
      scopes: ['drive.read'],
      resourceConstraint: 'drive_research',
      auditRef: root.auditRef,
    });
  });

  it('denies a write on a read grant, another resource, an expired, early or revoked grant', () => {
    const use = { action: 'drive.read', resource: 'drive_research', now: GRANT_NOW };
    expect(authorityForCall(root, { ...use, action: 'docs.publish' })).toEqual({
      denied: 'no_matching_permission',
    });
    expect(authorityForCall(root, { ...use, resource: 'github_code' })).toEqual({
      denied: 'no_matching_permission',
    });
    expect(authorityForCall(root, { ...use, now: root.expiresAt })).toEqual({ denied: 'expired' });
    expect(authorityForCall(root, { ...use, now: '2026-10-31T00:00:00.000Z' })).toEqual({
      denied: 'not_yet_valid',
    });
    const revoked: StandingGrant = {
      ...root,
      revocation: { status: 'revoked', revokedAt: GRANT_NOW, revokedBy: 'local-test:admin' },
    };
    expect(authorityForCall(revoked, use)).toEqual({ denied: 'revoked' });
  });
});

describe('child grant is an intersection, never a union', () => {
  it('issues a narrower child that the canonical subset rule accepts', () => {
    const result = child();
    if (!result.ok) throw new Error(result.reasons.join());
    expect(result.grant).toMatchObject({
      parentGrantId: root.grantId,
      depth: 1,
      sponsor: root.sponsor,
      policyRevision: root.policyRevision,
      revocation: { status: 'active' },
    });
    expect(
      authoritySubset(
        toDelegationAuthority(result.grant, GRANT_DEPLOYMENT),
        // Same sponsor and zone; only the bot differs by design.
        {
          ...toDelegationAuthority(root, GRANT_DEPLOYMENT),
          agentPrincipal: toDelegationAuthority(result.grant, GRANT_DEPLOYMENT).agentPrincipal,
        },
      ),
    ).toBe(true);
  });

  it('denies each widening on its own axis', () => {
    const wide = { ...childRequestFixture.limits };
    expect(
      denials({ permissions: [{ action: 'docs.publish', resource: 'drive_research' }] }),
    ).toEqual(['permission_widened']);
    expect(denials({ permissions: [{ action: 'drive.read', resource: 'drive_secret' }] })).toEqual([
      'permission_widened',
    ]);
    expect(denials({ expiresAt: '2026-12-02T00:00:00.000Z' })).toEqual(['expiry_widened']);
    expect(denials({ issuedAt: '2026-10-30T00:00:00.000Z' })).toEqual(['issued_before_parent']);
    expect(denials({ maxDepth: 3 })).toEqual(['max_depth_widened']);
    expect(denials({ maxDepth: 0 })).toEqual(['depth_exceeded']);
    expect(
      denials({
        schedule: {
          allowed: true,
          minIntervalSeconds: 60,
          maxLifetimeSeconds: 10,
          maxActiveRoutines: 1,
        },
      }),
    ).toEqual(['schedule_widened']);
    expect(denials({ limits: { ...wide, maxConcurrency: 5 } })).toEqual(['concurrency_widened']);
    expect(denials({ limits: { ...wide, maxFanOut: 6 } })).toEqual(['fan_out_widened']);
    expect(
      denials({ limits: { ...wide, budget: { ...wide.budget, inferenceSteps: 41 } } }),
    ).toEqual(['budget_widened']);
  });

  it('gives no schedule right to a child of a parent that has none', () => {
    const noSchedule: StandingGrant = {
      ...root,
      schedule: {
        allowed: false,
        minIntervalSeconds: 0,
        maxLifetimeSeconds: 0,
        maxActiveRoutines: 0,
      },
    };
    const request = {
      ...childRequestFixture,
      schedule: {
        allowed: true,
        minIntervalSeconds: 3600,
        maxLifetimeSeconds: 10,
        maxActiveRoutines: 1,
      },
    };
    const result = deriveChildGrant(noSchedule, request, GRANT_NOW);
    expect(result).toEqual({ ok: false, reasons: ['schedule_widened'] });
  });

  it('refuses a child of an expired or revoked parent, and a grandchild past the depth cap', () => {
    const expired = deriveChildGrant(root, childRequestFixture, root.expiresAt);
    expect(expired).toEqual({ ok: false, reasons: ['parent_unusable'] });
    const revoked: StandingGrant = {
      ...root,
      revocation: { status: 'revoked', revokedAt: GRANT_NOW, revokedBy: 'local-test:admin' },
    };
    expect(deriveChildGrant(revoked, childRequestFixture, GRANT_NOW)).toEqual({
      ok: false,
      reasons: ['parent_unusable'],
    });
    const first = child();
    if (!first.ok) throw new Error('first child');
    const second = deriveChildGrant(
      first.grant,
      { ...childRequestFixture, grantId: 'g2' },
      GRANT_NOW,
    );
    if (!second.ok) throw new Error(second.reasons.join());
    expect(second.grant.depth).toBe(2);
    expect(
      deriveChildGrant(second.grant, { ...childRequestFixture, grantId: 'g3' }, GRANT_NOW),
    ).toEqual({ ok: false, reasons: ['depth_exceeded'] });
  });

  it('keeps sponsor, issuer, depth and policy revision out of the requester control', () => {
    const forged = {
      ...childRequestFixture,
      sponsor: 'local-test:mallory',
      depth: 0,
      parentGrantId: null,
      policyRevision: 'policy-r9',
    } as unknown as ChildGrantRequest;
    const result = deriveChildGrant(root, forged, GRANT_NOW);
    if (!result.ok) throw new Error(result.reasons.join());
    expect(result.grant.sponsor).toBe(root.sponsor);
    expect(result.grant.depth).toBe(1);
    expect(result.grant.policyRevision).toBe(root.policyRevision);
  });

  it('revoking any ancestor stops every descendant', () => {
    const first = child();
    if (!first.ok) throw new Error('first child');
    expect(chainUsable([root, first.grant], GRANT_NOW)).toBe(true);
    const revoked: StandingGrant = {
      ...root,
      revocation: { status: 'revoked', revokedAt: GRANT_NOW, revokedBy: 'local-test:admin' },
    };
    expect(chainUsable([revoked, first.grant], GRANT_NOW)).toBe(false);
    expect(chainUsable([root, first.grant], first.grant.expiresAt)).toBe(false);
  });

  const permission = fc.record({
    action: fc.constantFrom('drive.read', 'github.read', 'docs.publish', 'bigquery.query'),
    resource: fc.constantFrom('drive_research', 'drive_context', 'github_issue', 'drive_secret'),
  });
  const day = fc
    .integer({ min: 0, max: 60 })
    .map((n) => new Date(Date.UTC(2026, 10, 1 + n)).toISOString());
  const request = fc.record({
    permissions: fc.array(permission, { minLength: 1, maxLength: 5 }),
    issuedAt: day,
    expiresAt: day,
    maxDepth: fc.integer({ min: 0, max: 4 }),
    schedule: fc.record({
      allowed: fc.boolean(),
      minIntervalSeconds: fc.integer({ min: 0, max: 7200 }),
      maxLifetimeSeconds: fc.integer({ min: 0, max: 172_800 }),
      maxActiveRoutines: fc.integer({ min: 0, max: 6 }),
    }),
    maxConcurrency: fc.integer({ min: 0, max: 8 }),
    maxFanOut: fc.integer({ min: 0, max: 10 }),
    cost: fc.integer({ min: 0, max: 2_000_000 }),
    steps: fc.integer({ min: 0, max: 80 }),
    parallelism: fc.integer({ min: 0, max: 8 }),
  });

  it('property: an accepted child is within the parent on every axis; a refused one widens some axis', () => {
    fc.assert(
      fc.property(request, (r) => {
        if (Date.parse(r.expiresAt) <= Date.parse(r.issuedAt)) return;
        const body: ChildGrantRequest = {
          ...childRequestFixture,
          permissions: r.permissions,
          issuedAt: r.issuedAt,
          expiresAt: r.expiresAt,
          maxDepth: r.maxDepth,
          schedule: r.schedule,
          limits: {
            maxConcurrency: r.maxConcurrency,
            maxFanOut: r.maxFanOut,
            budget: {
              approval: 'PLACEHOLDER',
              estimatedCostMicros: r.cost,
              inferenceSteps: r.steps,
              parallelism: r.parallelism,
            },
          },
        };
        const result = deriveChildGrant(root, body, GRANT_NOW);
        const parentPairs = new Set(root.permissions.map((p) => `${p.action}|${p.resource}`));
        const widens =
          !r.permissions.every((p) => parentPairs.has(`${p.action}|${p.resource}`)) ||
          Date.parse(r.expiresAt) > Date.parse(root.expiresAt) ||
          Date.parse(r.issuedAt) < Date.parse(root.issuedAt) ||
          r.maxDepth > root.maxDepth ||
          1 > r.maxDepth ||
          (r.schedule.allowed &&
            (r.schedule.minIntervalSeconds < root.schedule.minIntervalSeconds ||
              r.schedule.maxLifetimeSeconds > root.schedule.maxLifetimeSeconds ||
              r.schedule.maxActiveRoutines > root.schedule.maxActiveRoutines)) ||
          r.maxConcurrency > root.limits.maxConcurrency ||
          r.maxFanOut > root.limits.maxFanOut ||
          r.cost > root.limits.budget.estimatedCostMicros ||
          r.steps > root.limits.budget.inferenceSteps ||
          r.parallelism > root.limits.budget.parallelism;
        expect(result.ok).toBe(!widens);
        if (result.ok) {
          const authority = toDelegationAuthority(result.grant, GRANT_DEPLOYMENT);
          const parent = {
            ...toDelegationAuthority(root, GRANT_DEPLOYMENT),
            agentPrincipal: authority.agentPrincipal,
          };
          expect(authoritySubset(authority, parent)).toBe(true);
        }
      }),
      { numRuns: 500 },
    );
  });
});

describe('contract identity', () => {
  it('is versioned', () => {
    expect(STANDING_GRANT_CONTRACT_VERSION).toBe('teamwork.grant.v1');
  });
});
