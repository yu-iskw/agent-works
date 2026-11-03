import { describe, expect, it } from 'vitest';

import { readGrantActivation } from './lifecycle.js';
import {
  admin,
  analyst,
  budget,
  childRequest,
  clock,
  coordinator,
  lifecycleOver,
  member,
  off,
  owner,
  rootRequest,
  schedule,
  useStores,
} from './test-kit.js';

import type { ChildDenial } from '@agent-works/domain/standing-grant-contract';

const stores = useStores();

describe('activation flag', () => {
  it('defaults OFF and needs both the switch and an O04 approval reference', () => {
    expect(readGrantActivation({})).toEqual({ enabled: false });
    expect(readGrantActivation({ AW_STANDING_GRANTS: 'on' })).toEqual({ enabled: false });
    expect(readGrantActivation({ AW_STANDING_GRANTS_O04_REF: 'O04-1' })).toEqual({
      enabled: false,
    });
    expect(
      readGrantActivation({ AW_STANDING_GRANTS: 'true', AW_STANDING_GRANTS_O04_REF: 'x' }),
    ).toEqual({ enabled: false });
    expect(
      readGrantActivation({ AW_STANDING_GRANTS: 'on', AW_STANDING_GRANTS_O04_REF: 'O04-1' }),
    ).toEqual({ enabled: true, o04ApprovalRef: 'O04-1' });
  });
});

const STORES = ['memory', 'postgres'] as const;

function rigOn(
  storeName: string,
  activation?: Parameters<typeof lifecycleOver>[2],
  newId?: () => string,
) {
  const store = stores.cases.find((c) => c.name === storeName)!.make();
  const time = clock();
  return { store, time, lifecycle: lifecycleOver(store, time, activation, newId) };
}

describe.each(STORES)('grant issuance gate on %s', (storeName) => {
  const rig = (activation?: Parameters<typeof lifecycleOver>[2], newId?: () => string) =>
    rigOn(storeName, activation, newId);

  it('denies issuance while the O04 flag is off, even for the owner, and stores nothing', async () => {
    const { store, lifecycle } = rig({ enabled: false }, () => 'grant-denied');
    const root = await lifecycle.issueRoot(owner, rootRequest());
    expect(root).toEqual({ ok: false, code: 'ACTIVATION_OFF' });
    expect(await store.list()).toEqual([]);
    expect(await lifecycle.audit('grant-denied')).toMatchObject([
      { event: 'issue_denied', actor: owner.kind === 'human' ? owner.sub : '' },
    ]);
  });

  it('denies child issuance while the flag is off', async () => {
    const on = rig();
    const issued = await on.lifecycle.issueRoot(owner, rootRequest());
    if (!issued.ok) throw new Error('setup');
    const offLifecycle = lifecycleOver(on.store, on.time, { enabled: false });
    expect(
      await offLifecycle.issueChild(coordinator, issued.grant.grantId, childRequest()),
    ).toEqual({ ok: false, code: 'ACTIVATION_OFF' });
  });
});

describe.each(STORES)('who may issue a root grant on %s', (storeName) => {
  const rig = (activation?: Parameters<typeof lifecycleOver>[2], newId?: () => string) =>
    rigOn(storeName, activation, newId);
  it('lets the owner issue (positive control) and records the audit trail', async () => {
    const { lifecycle } = rig();
    const result = await lifecycle.issueRoot(owner, rootRequest());
    expect(result).toMatchObject({
      ok: true,
      grant: {
        issuer: 'local-test:owner',
        sponsor: 'alice',
        depth: 0,
        parentGrantId: null,
        revocation: { status: 'active' },
        policyRevision: 'policy-r1',
      },
    });
    if (!result.ok) return;
    expect(await lifecycle.audit(result.grant.grantId)).toMatchObject([
      { event: 'issued', actor: 'local-test:owner', detail: { sponsor: 'alice', depth: 0 } },
    ]);
  });

  it('lets an admin issue', async () => {
    expect((await rig().lifecycle.issueRoot(admin, rootRequest())).ok).toBe(true);
  });

  it.each([
    ['a non-admin member', member],
    ['a bot, as when a model proposes its own grant', coordinator],
  ])('denies %s', async (_who, actor) => {
    const { store, lifecycle } = rig();
    expect(await lifecycle.issueRoot(actor, rootRequest())).toEqual({
      ok: false,
      code: 'NOT_AUTHORIZED',
    });
    expect(await store.list()).toEqual([]);
  });

  it('denies a lifetime beyond the ceiling, a bot sponsor and an empty permission list', async () => {
    const { lifecycle } = rig();
    expect(
      await lifecycle.issueRoot(owner, rootRequest({ expiresAt: '2030-01-01T00:00:00.000Z' })),
    ).toEqual({ ok: false, code: 'LIFETIME_EXCEEDED' });
    expect(await lifecycle.issueRoot(owner, rootRequest({ sponsor: 'bot:x@1' }))).toEqual({
      ok: false,
      code: 'INVALID_REQUEST',
    });
    expect(await lifecycle.issueRoot(owner, rootRequest({ permissions: [] }))).toEqual({
      ok: false,
      code: 'INVALID_REQUEST',
    });
  });
});

describe.each(STORES)('parent/child intersection on %s', (storeName) => {
  const rig = (activation?: Parameters<typeof lifecycleOver>[2], newId?: () => string) =>
    rigOn(storeName, activation, newId);
  async function withRoot() {
    const r = rig();
    const root = await r.lifecycle.issueRoot(owner, rootRequest());
    if (!root.ok) throw new Error('setup');
    return { ...r, parentId: root.grant.grantId, rootGrant: root.grant };
  }

  it('accepts a narrower child and fixes sponsor, issuer, depth and revision itself', async () => {
    const { lifecycle, parentId } = await withRoot();
    const result = await lifecycle.issueChild(coordinator, parentId, childRequest());
    expect(result).toMatchObject({
      ok: true,
      grant: {
        sponsor: 'alice',
        issuer: 'bot:coordinator@1',
        depth: 1,
        parentGrantId: parentId,
        policyRevision: 'policy-r1',
        revocation: { status: 'active' },
      },
    });
  });

  it('accepts a child exactly equal to the parent on every axis (boundary)', async () => {
    const { lifecycle, parentId, rootGrant } = await withRoot();
    const result = await lifecycle.issueChild(
      coordinator,
      parentId,
      childRequest({
        permissions: rootGrant.permissions,
        expiresAt: rootGrant.expiresAt,
        maxDepth: rootGrant.maxDepth,
        schedule: rootGrant.schedule,
        limits: rootGrant.limits,
      }),
    );
    expect(result.ok).toBe(true);
  });

  const widenings: readonly [string, ChildDenial, Record<string, unknown>][] = [
    [
      'a resource outside the parent',
      'permission_widened',
      { permissions: [{ action: 'drive.read', resource: 'drive_secret' }] },
    ],
    [
      'an action outside the parent',
      'permission_widened',
      { permissions: [{ action: 'drive.write', resource: 'drive_research' }] },
    ],
    ['a later expiry', 'expiry_widened', { expiresAt: '2027-06-01T00:00:00.000Z' }],
    ['a deeper max depth', 'max_depth_widened', { maxDepth: 3 }],
    [
      'a schedule the parent lacks',
      'schedule_widened',
      { schedule: { ...schedule, minIntervalSeconds: 60 } },
    ],
    [
      'a longer routine lifetime',
      'schedule_widened',
      { schedule: { ...schedule, maxLifetimeSeconds: 999_999 } },
    ],
    [
      'more active routines',
      'schedule_widened',
      { schedule: { ...schedule, maxActiveRoutines: 9 } },
    ],
    [
      'more concurrency',
      'concurrency_widened',
      { limits: { maxConcurrency: 9, maxFanOut: 1, budget } },
    ],
    ['more fan-out', 'fan_out_widened', { limits: { maxConcurrency: 1, maxFanOut: 9, budget } }],
    [
      'a larger cost budget',
      'budget_widened',
      {
        limits: {
          maxConcurrency: 1,
          maxFanOut: 1,
          budget: { ...budget, estimatedCostMicros: 9_000_000 },
        },
      },
    ],
    [
      'more inference steps',
      'budget_widened',
      {
        limits: { maxConcurrency: 1, maxFanOut: 1, budget: { ...budget, inferenceSteps: 400 } },
      },
    ],
    [
      'more parallelism',
      'budget_widened',
      { limits: { maxConcurrency: 1, maxFanOut: 1, budget: { ...budget, parallelism: 40 } } },
    ],
  ];

  it.each(widenings)('denies %s and stores no child', async (_label, reason, patch) => {
    const { store, lifecycle, parentId } = await withRoot();
    const result = await lifecycle.issueChild(coordinator, parentId, childRequest(patch));
    expect(result).toMatchObject({ ok: false, code: 'WIDENED' });
    expect(result.ok ? [] : result.reasons).toContain(reason);
    expect(await store.list()).toHaveLength(1);
  });

  it('allows a schedule only when the parent has one, and a disabled child schedule always', async () => {
    const r = rig();
    const root = await r.lifecycle.issueRoot(owner, rootRequest({ schedule: off }));
    if (!root.ok) throw new Error('setup');
    const denied = await r.lifecycle.issueChild(
      coordinator,
      root.grant.grantId,
      childRequest({ schedule }),
    );
    expect(denied).toMatchObject({ ok: false, reasons: ['schedule_widened'] });
    expect((await r.lifecycle.issueChild(coordinator, root.grant.grantId, childRequest())).ok).toBe(
      true,
    );
  });

  it('caps chain depth: a grandchild fits maxDepth 2, a great-grandchild does not', async () => {
    const { lifecycle, parentId } = await withRoot();
    const child = await lifecycle.issueChild(coordinator, parentId, childRequest());
    if (!child.ok) throw new Error('setup');
    const grandchild = await lifecycle.issueChild(
      analyst,
      child.grant.grantId,
      childRequest({ grantee: { botId: 'writer', botVersion: 1 } }),
    );
    expect(grandchild).toMatchObject({ ok: true, grant: { depth: 2 } });
    if (!grandchild.ok) return;
    const tooDeep = await lifecycle.issueChild(
      { kind: 'bot', botId: 'writer', botVersion: 1 },
      grandchild.grant.grantId,
      childRequest({ grantee: { botId: 'extra', botVersion: 1 } }),
    );
    expect(tooDeep).toMatchObject({ ok: false, code: 'WIDENED', reasons: ['depth_exceeded'] });
  });

  it('denies a child from anyone but the parent grantee, or for an unknown parent', async () => {
    const { lifecycle, parentId } = await withRoot();
    for (const actor of [analyst, owner, member]) {
      expect(await lifecycle.issueChild(actor, parentId, childRequest())).toEqual({
        ok: false,
        code: 'NOT_PARENT_GRANTEE',
      });
    }
    expect(await lifecycle.issueChild(coordinator, 'missing', childRequest())).toEqual({
      ok: false,
      code: 'PARENT_NOT_FOUND',
    });
  });

  it('enforces the active-children cap and frees a slot on revocation', async () => {
    const { lifecycle, parentId } = await withRoot();
    const ids: string[] = [];
    for (let i = 0; i < 3; i += 1) {
      const r = await lifecycle.issueChild(coordinator, parentId, childRequest());
      if (!r.ok) throw new Error('setup');
      ids.push(r.grant.grantId);
    }
    expect(await lifecycle.issueChild(coordinator, parentId, childRequest())).toEqual({
      ok: false,
      code: 'FAN_OUT_EXCEEDED',
    });
    await lifecycle.revoke(owner, ids[0] ?? '', 'free a slot');
    expect((await lifecycle.issueChild(coordinator, parentId, childRequest())).ok).toBe(true);
  });

  it('denies a child of an expired or revoked parent', async () => {
    const a = await withRoot();
    a.time.advanceDays(31);
    expect(await a.lifecycle.issueChild(coordinator, a.parentId, childRequest())).toEqual({
      ok: false,
      code: 'PARENT_UNUSABLE',
    });
    const b = await withRoot();
    await b.lifecycle.revoke(owner, b.parentId, 'gone');
    expect(await b.lifecycle.issueChild(coordinator, b.parentId, childRequest())).toEqual({
      ok: false,
      code: 'PARENT_UNUSABLE',
    });
  });

  it('denies a grandchild when a higher ancestor is revoked', async () => {
    const { lifecycle, parentId, store } = await withRoot();
    const child = await lifecycle.issueChild(coordinator, parentId, childRequest());
    if (!child.ok) throw new Error('setup');
    const direct = await store.revokeTree({
      grantId: parentId,
      by: 'test',
      at: '2026-11-03T00:00:00.000Z',
      reason: 'x',
    });
    expect(direct).toContain(child.grant.grantId);
    expect(await lifecycle.issueChild(analyst, child.grant.grantId, childRequest())).toEqual({
      ok: false,
      code: 'PARENT_UNUSABLE',
    });
  });
});

describe.each(STORES)('revocation on %s', (storeName) => {
  const rig = (activation?: Parameters<typeof lifecycleOver>[2], newId?: () => string) =>
    rigOn(storeName, activation, newId);
  async function chain() {
    const r = rig();
    const root = await r.lifecycle.issueRoot(owner, rootRequest());
    if (!root.ok) throw new Error('setup');
    const child = await r.lifecycle.issueChild(coordinator, root.grant.grantId, childRequest());
    if (!child.ok) throw new Error('setup');
    const grandchild = await r.lifecycle.issueChild(
      analyst,
      child.grant.grantId,
      childRequest({ grantee: { botId: 'writer', botVersion: 1 } }),
    );
    if (!grandchild.ok) throw new Error('setup');
    return {
      ...r,
      rootId: root.grant.grantId,
      childId: child.grant.grantId,
      leafId: grandchild.grant.grantId,
    };
  }

  it('revokes the whole subtree, leaves a sibling subtree alone, and audits each grant', async () => {
    const c = await chain();
    const sibling = await c.lifecycle.issueChild(coordinator, c.rootId, childRequest());
    if (!sibling.ok) throw new Error('setup');
    const result = await c.lifecycle.revoke(owner, c.childId, 'compromised');
    expect(result).toMatchObject({ ok: true });
    expect(result.ok && [...result.revoked].sort()).toEqual([c.childId, c.leafId].sort());
    expect((await c.store.get(c.leafId))?.revocation).toMatchObject({
      status: 'revoked',
      revokedBy: 'local-test:owner',
    });
    expect((await c.store.get(c.rootId))?.revocation.status).toBe('active');
    expect((await c.store.get(sibling.grant.grantId))?.revocation.status).toBe('active');
    expect((await c.lifecycle.audit(c.childId)).map((e) => e.event)).toEqual(['issued', 'revoked']);
    expect((await c.lifecycle.audit(c.leafId)).map((e) => e.event)).toEqual([
      'issued',
      'revoked_by_ancestor',
    ]);
  });

  it('is idempotent: a repeat revokes nothing and adds no audit row', async () => {
    const c = await chain();
    await c.lifecycle.revoke(owner, c.rootId, 'first');
    const before = (await c.lifecycle.audit(c.leafId)).length;
    expect(await c.lifecycle.revoke(owner, c.rootId, 'second')).toEqual({
      ok: true,
      revoked: [],
    });
    expect(await c.lifecycle.audit(c.leafId)).toHaveLength(before);
  });

  it('lets the sponsor revoke and denies another member and any bot', async () => {
    const c = await chain();
    const alice = { kind: 'human', sub: 'alice', role: 'member' } as const;
    for (const actor of [member, coordinator]) {
      expect(await c.lifecycle.revoke(actor, c.rootId, 'no')).toEqual({
        ok: false,
        code: 'NOT_AUTHORIZED',
      });
    }
    expect((await c.store.get(c.rootId))?.revocation.status).toBe('active');
    expect(await c.lifecycle.revoke(alice, c.rootId, 'mine')).toMatchObject({ ok: true });
    expect(await c.lifecycle.revoke(owner, 'missing', 'x')).toEqual({
      ok: false,
      code: 'NOT_FOUND',
    });
  });

  it('revokeSponsor revokes every root grant of that sponsor and their children', async () => {
    const c = await chain();
    const other = await c.lifecycle.issueRoot(owner, rootRequest({ sponsor: 'bob' }));
    if (!other.ok) throw new Error('setup');
    const result = await c.lifecycle.revokeSponsor(owner, 'alice', 'left the company');
    expect(result.ok && result.revoked).toHaveLength(3);
    expect((await c.store.get(c.leafId))?.revocation.status).toBe('revoked');
    expect((await c.store.get(other.grant.grantId))?.revocation.status).toBe('active');
  });

  it('still works while issuance is switched off', async () => {
    const c = await chain();
    const frozen = lifecycleOver(c.store, c.time, { enabled: false });
    expect(await frozen.revoke(owner, c.rootId, 'freeze')).toMatchObject({ ok: true });
  });
});

describe.each(STORES)('review on %s', (storeName) => {
  const rig = (activation?: Parameters<typeof lifecycleOver>[2], newId?: () => string) =>
    rigOn(storeName, activation, newId);
  it('reports effective status and records a human review decision', async () => {
    const r = rig();
    const root = await r.lifecycle.issueRoot(owner, rootRequest());
    if (!root.ok) throw new Error('setup');
    const child = await r.lifecycle.issueChild(coordinator, root.grant.grantId, childRequest());
    if (!child.ok) throw new Error('setup');
    const short = await r.lifecycle.issueRoot(
      owner,
      rootRequest({ sponsor: 'bob', expiresAt: '2026-11-05T00:00:00.000Z' }),
    );
    if (!short.ok) throw new Error('setup');

    r.time.advanceDays(6);
    const statuses = Object.fromEntries(
      (await r.lifecycle.listForReview()).map((row) => [row.grant.grantId, row.status]),
    );
    expect(statuses).toEqual({
      [root.grant.grantId]: 'active',
      [child.grant.grantId]: 'active',
      [short.grant.grantId]: 'expired',
    });

    expect(
      await r.lifecycle.review(member, root.grant.grantId, { decision: 'keep', note: 'x' }),
    ).toEqual({ ok: false, code: 'NOT_AUTHORIZED' });
    expect(
      await r.lifecycle.review(admin, root.grant.grantId, { decision: 'revoke', note: 'stale' }),
    ).toMatchObject({ ok: true });
    const after = await r.lifecycle.listForReview({ sponsor: 'alice' });
    expect(after.map((row) => row.status)).toEqual(['revoked', 'revoked']);
    expect((await r.lifecycle.audit(root.grant.grantId)).map((e) => e.event)).toEqual([
      'issued',
      'reviewed',
      'revoked',
    ]);
  });
});
