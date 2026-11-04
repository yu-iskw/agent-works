import { canonicalPayloadSha256, ticketCreateManifest } from '@agent-works/domain';
import { decide } from '@agent-works/policy';
import { describe, expect, it } from 'vitest';

import { createMemoryLedgerPort } from '../ports/memory/ledger-port.js';

import { createMemoryApprovalStore } from './approvals.js';
import { resolveAuthority } from './authority.js';
import { TICKET_TOOL, createBroker } from './broker.js';

import type { AuthorityResolution, AuthorityVerdict } from './authority.js';
import type { ExecuteInput } from './broker.js';
import type { Approval, Authority, OutboxEvent } from '@agent-works/domain';
import type { DelegationAuthority } from '@agent-works/domain/delegation';
import type { PolicyFacts } from '@agent-works/policy';

const start = new Date('2026-10-11T12:00:00.000Z');
const payload = { summary: 'Ship the fix', project: 'PROJ' };
const scope = ticketCreateManifest.spec.permissions.workloadCapability;

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

const authority: Authority = {
  kind: 'userDelegated',
  scopes: [scope],
  resourceConstraint: 'PROJ',
  expiresAt: '2026-10-11T13:00:00.000Z',
  auditRef: 'audit-1',
};

const parent: DelegationAuthority = {
  subject: 'alice',
  agentPrincipal: 'agent:broker',
  governanceZone: 'zone-a',
  region: 'jp',
  grants: [{ capability: scope, resource: 'PROJ' }],
  expiresAt: '2026-10-11T13:00:00.000Z',
  policyDecisionRef: 'pd-1',
};

function granted(patch: Partial<Extract<AuthorityResolution, { kind: 'granted' }>> = {}) {
  return { kind: 'granted', subject: 'alice', authority, facts: allow, ...patch } as const;
}

function approval(patch: Partial<Approval> = {}): Approval {
  return {
    id: 'apr-1',
    taskId: 'tsk-1',
    stepId: 'step-1',
    tool: TICKET_TOOL,
    targetResource: 'PROJ',
    payloadSha256: canonicalPayloadSha256(payload),
    requestedBySub: 'alice',
    approverSub: 'bob',
    state: 'approved',
    expiresAt: '2026-12-01T00:00:00.000Z',
    maxExecutions: 1,
    executionsUsed: 0,
    ...patch,
  };
}

type Resolve = () => AuthorityResolution | Promise<AuthorityResolution>;

function rig(initial: Resolve = () => granted()) {
  const store = createMemoryApprovalStore();
  const ledger = createMemoryLedgerPort(() => start);
  const events: OutboxEvent[] = [];
  const state = {
    now: start,
    resolve: initial,
    posts: 0,
    approverOk: true,
    beforeEffect: undefined as (() => Promise<void>) | undefined,
  };
  const broker = createBroker({
    store,
    decide,
    ledger: {
      ...ledger,
      submit: ledger.submit.bind(ledger),
      read: ledger.read.bind(ledger),
      append(event) {
        events.push(event);
        return ledger.append(event);
      },
    },
    approverAuthorized: () => state.approverOk,
    now: () => state.now,
    beforeToolCall: async () => {
      await state.beforeEffect?.();
    },
    authorize: async () => {
      return state.resolve();
    },
    postTicket: () => {
      state.posts += 1;
      return Promise.resolve('FAKE-1');
    },
  });
  const call = (patch: Partial<ExecuteInput> = {}) =>
    broker.execute({
      id: 'call-1',
      taskId: 'tsk-1',
      stepId: 'step-1',
      toolRef: TICKET_TOOL,
      idempotencyKey: 'key-1',
      targetResource: 'PROJ',
      payload,
      approvalId: 'apr-1',
      actorSub: 'alice',
      traceId: 'trace-1',
      facts: allow,
      ...patch,
    });
  return { store, state, events, call };
}

async function seeded(initial?: Resolve, row: Partial<Approval> = {}) {
  const harness = rig(initial);
  await harness.store.save(approval(row));
  return harness;
}

const denied = { ok: false, status: 403, code: 'AUTHORITY_DENIED' };

function kinds(events: readonly OutboxEvent[]): string[] {
  return events.map((item) => item.event.eventType);
}

function denialEvents(events: readonly OutboxEvent[]): OutboxEvent[] {
  return events.filter((item) => item.event.eventType === 'tool.denied');
}

describe('owner positive controls', () => {
  it('executes once for the resolved owner and keeps workload identity separate', async () => {
    const { call, state, events, store } = await seeded();
    expect(await call()).toEqual({ ok: true, receipt: 'FAKE-1', replay: false });
    expect(state.posts).toBe(1);
    expect(events[0]?.event).toMatchObject({
      eventType: 'tool.intended',
      initiatorSubject: 'alice',
      agentPrincipal: 'agent:broker',
    });
    expect(await store.read('apr-1')).toMatchObject({ executionsUsed: 1 });
  });

  it('replays the receipt without a second provider call', async () => {
    const { call, state } = await seeded();
    await call();
    expect(await call()).toEqual({ ok: true, receipt: 'FAKE-1', replay: true });
    expect(state.posts).toBe(1);
  });

  it('takes policy facts from the server, so client facts cannot grant or withhold', async () => {
    const { call, state } = await seeded();
    expect(await call({ facts: {} })).toMatchObject({ ok: true });
    expect(state.posts).toBe(1);
  });

  it('accepts a child authority that is a subset of its parent', async () => {
    const child = { ...parent, expiresAt: '2026-10-11T12:30:00.000Z' };
    const { call, state } = await seeded(() => granted({ delegation: { child, parent } }));
    expect(await call()).toMatchObject({ ok: true });
    expect(state.posts).toBe(1);
  });
});

describe('denials never reach the provider', () => {
  const widerChild = {
    ...parent,
    grants: [...parent.grants, { capability: scope, resource: 'OTHER' }],
  };
  const cases: readonly [string, Resolve, Partial<ExecuteInput>?][] = [
    [
      'expired authority',
      () => granted({ authority: { ...authority, expiresAt: '2026-10-11T12:00:00.000Z' } }),
    ],
    [
      'resource mismatch',
      () => granted({ authority: { ...authority, resourceConstraint: 'OTHER' } }),
    ],
    ['actor substitution', () => granted({ subject: 'alice' }), { actorSub: 'mallory' }],
    ['scope escalation', () => granted({ authority: { ...authority, scopes: ['ticket.read'] } })],
    [
      'workload authority standing in for the user',
      () => granted({ authority: { ...authority, kind: 'agentOwned' } }),
    ],
    ['child with extra grants', () => granted({ delegation: { child: widerChild, parent } })],
    [
      'child outliving parent',
      () =>
        granted({
          delegation: { child: { ...parent, expiresAt: '2026-10-11T14:00:00.000Z' }, parent },
        }),
    ],
    [
      'child lacking the grant for this call',
      () => granted({ delegation: { child: { ...parent, grants: [] }, parent } }),
    ],
    [
      'child of another subject',
      () => granted({ delegation: { child: { ...parent, subject: 'bob' }, parent } }),
    ],
    [
      'malformed authority',
      () => granted({ authority: { ...authority, scopes: 'ticket.create' } as never }),
    ],
    ['revoked grant', () => ({ kind: 'denied', reason: 'revoked' })],
    ['removed membership', () => ({ kind: 'denied', reason: 'membership_removed' })],
    ['disabled connector', () => ({ kind: 'denied', reason: 'connector_disabled' })],
  ];

  it.each(cases)('%s', async (_name, resolve, patch) => {
    const { call, state, store, events } = await seeded(resolve);
    expect(await call(patch)).toEqual(denied);
    expect(state.posts).toBe(0);
    expect(events).toEqual([]);
    expect(await store.read('apr-1')).toMatchObject({ executionsUsed: 0 });
  });

  it('approval requested by someone other than the resolved actor', async () => {
    const { call, state, events, store } = await seeded(undefined, { requestedBySub: 'carol' });
    expect(await call()).toEqual(denied);
    expect(state.posts).toBe(0);
    expect(events).toEqual([]);
    expect(await store.read('apr-1')).toMatchObject({ executionsUsed: 0 });
  });

  it('spoofed policy facts: the server denies whatever the client claims', async () => {
    const { call, state, events } = await seeded(() =>
      granted({ facts: { ...allow, user_or_service_has_resource_authority: false } }),
    );
    expect(await call({ facts: allow })).toEqual({
      ok: false,
      status: 422,
      code: 'POLICY_DENIED',
    });
    expect(state.posts).toBe(0);
    expect(events).toEqual([]);
  });
});

describe('transient directory failure', () => {
  it('is retryable and fail-closed, then succeeds once, with no approval consumed', async () => {
    const { call, state, store, events } = await seeded(() => {
      throw new Error('directory 503');
    });
    expect(await call()).toEqual({ ok: false, status: 503, code: 'AUTHORITY_UNAVAILABLE' });
    expect(state.posts).toBe(0);
    expect(events).toEqual([]);
    expect(await store.read('apr-1')).toMatchObject({ executionsUsed: 0 });
    state.resolve = () => granted();
    expect(await call()).toEqual({ ok: true, receipt: 'FAKE-1', replay: false });
    expect(state.posts).toBe(1);
  });

  it('fails closed when the directory drops between claim and effect', async () => {
    const { call, state, events } = await seeded();
    state.beforeEffect = () => {
      state.resolve = () => {
        throw new Error('directory timeout');
      };
      return Promise.resolve();
    };
    expect(await call()).toEqual({ ok: false, status: 503, code: 'AUTHORITY_UNAVAILABLE' });
    expect(state.posts).toBe(0);
    expect(kinds(events)).toEqual(['tool.intended', 'tool.denied']);
    expect(denialEvents(events)[0]?.event).toMatchObject({
      outcome: 'DENIED:AUTHORITY_UNAVAILABLE',
      approvalId: 'apr-1',
    });
  });
});

describe('revalidation immediately before the side effect', () => {
  it('denies when authority is revoked after the claim, and resumes once restored', async () => {
    const { call, state, store, events } = await seeded();
    state.beforeEffect = () => {
      state.resolve = () => ({ kind: 'denied', reason: 'revoked' });
      return Promise.resolve();
    };
    expect(await call()).toEqual(denied);
    expect(state.posts).toBe(0);
    expect(await store.read('apr-1')).toMatchObject({ executionsUsed: 1 });
    expect(kinds(events)).toEqual(['tool.intended', 'tool.denied']);
    expect(denialEvents(events)[0]?.event).toMatchObject({
      outcome: 'DENIED:AUTHORITY_DENIED',
      initiatorSubject: 'alice',
      agentPrincipal: 'agent:broker',
    });
    expect(await call()).toEqual(denied);
    expect(state.posts).toBe(0);
    expect(denialEvents(events)).toHaveLength(1);
    state.beforeEffect = undefined;
    state.resolve = () => granted();
    expect(await call({ traceId: 'trace-2' })).toEqual({
      ok: true,
      receipt: 'FAKE-1',
      replay: false,
    });
    expect(state.posts).toBe(1);
    expect(await call()).toEqual({ ok: true, receipt: 'FAKE-1', replay: true });
    expect(state.posts).toBe(1);
  });

  it('denies a retry after authority expiry', async () => {
    const { call, state, events } = await seeded();
    state.beforeEffect = () => {
      state.now = new Date('2026-10-11T13:00:01.000Z');
      return Promise.resolve();
    };
    expect(await call()).toEqual(denied);
    state.beforeEffect = undefined;
    expect(await call()).toEqual(denied);
    expect(state.posts).toBe(0);
    expect(kinds(events)).toEqual(['tool.intended', 'tool.denied']);
  });

  it('denies when the approval lapses or is withdrawn before the effect', async () => {
    const lapsed = await seeded();
    lapsed.state.beforeEffect = () => {
      lapsed.state.now = new Date('2026-12-02T00:00:00.000Z');
      lapsed.state.resolve = () =>
        granted({ authority: { ...authority, expiresAt: '2027-01-01T00:00:00.000Z' } });
      return Promise.resolve();
    };
    expect(await lapsed.call()).toEqual({ ok: false, status: 422, code: 'APPROVAL_EXPIRED' });
    expect(lapsed.state.posts).toBe(0);
    expect(denialEvents(lapsed.events)[0]?.event).toMatchObject({
      outcome: 'DENIED:APPROVAL_EXPIRED',
    });

    const withdrawn = await seeded();
    withdrawn.state.beforeEffect = () => {
      withdrawn.state.approverOk = false;
      return Promise.resolve();
    };
    expect(await withdrawn.call()).toEqual({ ok: false, status: 422, code: 'APPROVAL_REQUIRED' });
    expect(withdrawn.state.posts).toBe(0);
    expect(denialEvents(withdrawn.events)[0]?.event).toMatchObject({
      outcome: 'DENIED:APPROVAL_REQUIRED',
    });
  });

  it('denies when the approval is withdrawn between claim and effect', async () => {
    const { call, state, store, events } = await seeded();
    state.beforeEffect = async () => {
      await store.save(approval({ state: 'rejected', executionsUsed: 1 }));
    };
    expect(await call()).toEqual({ ok: false, status: 422, code: 'APPROVAL_REQUIRED' });
    expect(state.posts).toBe(0);
    expect(kinds(events)).toEqual(['tool.intended', 'tool.denied']);
  });

  it('denies a resume by an actor other than the one recorded at intent', async () => {
    // The approval is re-requested by the resumer, so the requester check passes and only the
    // recorded-actor check stands between the resumer and the provider.
    const first = granted({ subject: 'dave' });
    const { call, state, store, events } = await seeded(() => first, { requestedBySub: 'dave' });
    state.beforeEffect = () => {
      state.beforeEffect = undefined;
      return Promise.reject(new Error('crash after intent'));
    };
    await expect(call({ actorSub: 'dave' })).rejects.toThrow('crash after intent');
    await store.save(approval({ requestedBySub: 'carol', executionsUsed: 1 }));
    state.resolve = () => granted({ subject: 'carol' });
    expect(await call({ actorSub: 'carol' })).toEqual(denied);
    expect(state.posts).toBe(0);
    expect(kinds(events)).toEqual(['tool.intended', 'tool.denied']);
    expect(denialEvents(events)[0]?.event).toMatchObject({
      initiatorSubject: 'carol',
      outcome: 'DENIED:AUTHORITY_DENIED',
    });
    expect(events[0]?.event).toMatchObject({ initiatorSubject: 'dave' });
  });
});

describe('required authority kind', () => {
  const request = {
    claimedActor: 'alice',
    taskId: 'tsk-1',
    stepId: 'step-1',
    toolRef: TICKET_TOOL,
    targetResource: 'PROJ',
    approvalId: 'apr-1',
  };
  const workflow = { ...authority, kind: 'approvedServiceWorkflow' } as const;
  const verdictFor = (
    resolved: Authority,
    userAuthority: 'delegated' | 'approvedService',
  ): Promise<AuthorityVerdict> =>
    resolveAuthority(() => Promise.resolve(granted({ authority: resolved })), request, start, {
      workloadCapability: scope,
      userAuthority,
    });

  it('accepts an approved service workflow only where the tool declares approvedService', async () => {
    expect(await verdictFor(workflow, 'approvedService')).toMatchObject({ ok: true });
    expect(await verdictFor(authority, 'approvedService')).toMatchObject({ ok: false });
  });

  it('refuses an approved service workflow for a user-delegated tool', async () => {
    expect(await verdictFor(authority, 'delegated')).toMatchObject({ ok: true });
    expect(await verdictFor(workflow, 'delegated')).toMatchObject({ ok: false });
  });
});
