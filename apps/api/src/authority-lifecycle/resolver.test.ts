import { canonicalPayloadSha256 } from '@agent-works/domain';
import { decide } from '@agent-works/policy';
import { describe, expect, it } from 'vitest';

import { createMemoryApprovalStore } from '../broker/approvals.js';
import { TICKET_TOOL, createBroker } from '../broker/broker.js';
import { createMemoryLedgerPort } from '../ports/memory/ledger-port.js';

import { createStandingAuthorityResolver, resolveStandingAuthority } from './resolver.js';
import {
  TICKET_ACTION,
  childRequest,
  clock,
  coordinator,
  lifecycleOver,
  owner,
  rootRequest,
  useStores,
} from './test-kit.js';

import type { GrantStore } from './store.js';
import type { Approval } from '@agent-works/domain';
import type { PolicyFacts } from '@agent-works/policy';

const stores = useStores();
const payloadFor = (project: string) => ({ summary: 'Ship the fix', project });
const allow: PolicyFacts = {
  authenticated_actor: true,
  active_org_membership: true,
  permitted_app_role: true,
  approved_agent_and_skill_version: true,
  agent_has_tool_capability: true,
  user_or_service_has_resource_authority: true,
  source_system_allows_operation: true,
  data_classification_policy_allows: true,
  valid_approval_if_required: true,
  within_time_and_budget_bounds: true,
};

function approval(taskId: string, id: string, resource: string): Approval {
  return {
    id,
    taskId,
    stepId: 'step-1',
    tool: TICKET_TOOL,
    targetResource: resource,
    payloadSha256: canonicalPayloadSha256(payloadFor(resource)),
    requestedBySub: 'alice',
    approverSub: 'bob',
    state: 'approved',
    expiresAt: '2026-12-31T00:00:00.000Z',
    maxExecutions: 1,
    executionsUsed: 0,
  };
}

describe.each(['memory', 'postgres'])('standing authority through the broker on %s', (name) => {
  async function rig(overrides: { store?: GrantStore; enabled?: boolean } = {}) {
    const base = stores.cases.find((c) => c.name === name)!.make();
    const store = overrides.store ?? base;
    const time = clock();
    const lifecycle = lifecycleOver(base, time);
    const approvals = createMemoryApprovalStore();
    const ledger = createMemoryLedgerPort(() => time.now);
    const bound = new Map<string, string>();
    const posts = { count: 0 };
    const activation = { enabled: overrides.enabled ?? true, o04ApprovalRef: 'O04-test' };
    const broker = createBroker({
      store: approvals,
      decide,
      ledger,
      approverAuthorized: () => true,
      now: () => time.now,
      authorize: createStandingAuthorityResolver({
        store,
        activation,
        now: () => time.now,
        bindingFor: (request) => {
          const grantId = bound.get(request.taskId);
          return Promise.resolve(
            grantId === undefined ? undefined : { grantId, action: TICKET_ACTION },
          );
        },
        facts: () => Promise.resolve(allow),
      }),
      postTicket: () => {
        posts.count += 1;
        return Promise.resolve('FAKE-1');
      },
    });
    let n = 0;
    const queue = async (taskId: string, grantId: string, resource = 'PROJ') => {
      bound.set(taskId, grantId);
      await approvals.save(approval(taskId, `apr-${taskId}`, resource));
    };
    const run = (taskId: string, patch: { actorSub?: string; targetResource?: string } = {}) => {
      n += 1;
      return broker.execute({
        id: `call-${n}`,
        taskId,
        stepId: 'step-1',
        toolRef: TICKET_TOOL,
        idempotencyKey: `key-${n}`,
        targetResource: patch.targetResource ?? 'PROJ',
        payload: payloadFor(patch.targetResource ?? 'PROJ'),
        approvalId: `apr-${taskId}`,
        actorSub: patch.actorSub ?? 'alice',
        traceId: 'trace-1',
        facts: allow,
      });
    };
    const root = await lifecycle.issueRoot(owner, rootRequest());
    if (!root.ok) throw new Error('setup');
    return { store: base, time, lifecycle, queue, run, posts, rootId: root.grant.grantId };
  }

  const denied = { ok: false, status: 403, code: 'AUTHORITY_DENIED' };

  it('owner positive control: a live grant lets the sensitive call through exactly once', async () => {
    const r = await rig();
    await r.queue('tsk-1', r.rootId);
    expect(await r.run('tsk-1')).toMatchObject({ ok: true, receipt: 'FAKE-1' });
    expect(r.posts.count).toBe(1);
  });

  it('a revoked sponsor denies work queued before and after the revocation, with zero provider calls', async () => {
    const r = await rig();
    await r.queue('tsk-1', r.rootId);
    await r.queue('tsk-2', r.rootId);
    await r.lifecycle.revokeSponsor(owner, 'alice', 'offboarded');
    expect(await r.run('tsk-1')).toEqual(denied);
    expect(await r.run('tsk-2')).toEqual(denied);
    await r.queue('tsk-3', r.rootId);
    expect(await r.run('tsk-3')).toEqual(denied);
    expect(r.posts.count).toBe(0);
  });

  it('a grant that expires while work is queued denies it with zero provider calls', async () => {
    const r = await rig();
    await r.queue('tsk-1', r.rootId);
    r.time.advanceDays(31);
    expect(await r.run('tsk-1')).toEqual(denied);
    expect(r.posts.count).toBe(0);
  });

  it('revoking the root denies a child grant queued under it', async () => {
    const r = await rig();
    const child = await r.lifecycle.issueChild(
      coordinator,
      r.rootId,
      childRequest({ permissions: [{ action: TICKET_ACTION, resource: 'PROJ' }] }),
    );
    if (!child.ok) throw new Error('setup');
    await r.queue('tsk-1', child.grant.grantId);
    await r.lifecycle.revoke(owner, r.rootId, 'root revoked');
    expect(await r.run('tsk-1')).toEqual(denied);
    expect(r.posts.count).toBe(0);
  });

  it.each<[string, { targetResource?: string; actorSub?: string }]>([
    ['a resource outside the grant', { targetResource: 'OTHER' }],
    ['an actor other than the sponsor', { actorSub: 'mallory' }],
  ])('denies %s', async (_label, patch) => {
    const r = await rig();
    await r.queue('tsk-1', r.rootId, patch.targetResource);
    expect(await r.run('tsk-1', patch)).toEqual(denied);
    expect(r.posts.count).toBe(0);
  });

  it('denies a task with no grant binding and a grant that does not exist', async () => {
    const r = await rig();
    expect(await r.run('tsk-unbound')).toEqual(denied);
    await r.queue('tsk-1', 'grant-missing');
    expect(await r.run('tsk-1')).toEqual(denied);
    expect(r.posts.count).toBe(0);
  });

  it('denies every call while the O04 flag is off', async () => {
    const r = await rig({ enabled: false });
    await r.queue('tsk-1', r.rootId);
    expect(await r.run('tsk-1')).toEqual(denied);
    expect(r.posts.count).toBe(0);
  });

  it('fails closed and retryable when the store cannot be read', async () => {
    const real = stores.cases.find((c) => c.name === name)!.make();
    const broken: GrantStore = { ...real, chain: () => Promise.reject(new Error('db down')) };
    const r = await rig({ store: broken });
    await r.queue('tsk-1', r.rootId);
    expect(await r.run('tsk-1')).toEqual({
      ok: false,
      status: 503,
      code: 'AUTHORITY_UNAVAILABLE',
    });
    expect(r.posts.count).toBe(0);
  });

  it('caps the answer at the earliest expiry along the chain', async () => {
    const r = await rig();
    const child = await r.lifecycle.issueChild(coordinator, r.rootId, childRequest());
    if (!child.ok) throw new Error('setup');
    const answer = await resolveStandingAuthority(
      { store: r.store, activation: { enabled: true }, now: () => r.time.now },
      { grantId: child.grant.grantId, action: 'drive.read', resource: 'drive_research' },
    );
    expect(answer).toMatchObject({
      kind: 'granted',
      sponsor: 'alice',
      authority: { expiresAt: child.grant.expiresAt },
    });
  });
});
