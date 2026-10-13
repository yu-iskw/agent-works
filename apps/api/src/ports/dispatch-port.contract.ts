import { canonicalPayloadSha256 } from '@agent-works/domain';
import { describe, expect, it } from 'vitest';

import { DispatchInjectedFault, proofOf } from './dispatch-port.js';
import { LedgerConflict } from './ledger-port.js';

import type { AcceptTask, DispatchHarness, DispatchPort } from './dispatch-port.js';
import type { TaskLedger } from './ledger-port.js';
import type {
  ClaimedDelivery,
  LeaseProof,
  OutboxEvent,
  PolicyDecision,
  Principal,
  TaskSubmit,
} from '@agent-works/domain';

const caller = 'alice';
const idempotencyKey = 'accept-1';
const startedAt = '2026-10-10T10:00:00.000Z';
const deadline = '2026-10-10T10:05:00.000Z';
const otherDeadline = '2026-10-10T11:00:00.000Z';
const later = '2026-10-10T10:10:00.000Z';
const renewedUntil = '2026-10-10T10:02:00.000Z';
const leaseEnd = '2026-10-10T10:01:00.000Z';
const leaseMs = 60_000;
const objective = 'Summarize the runbook';
const decisionId = '6f1e2d3c-4b5a-4968-8c7d-6e5f4a3b2c1d';
const none = { tasks: 0, outbox: 0, deliveries: 0 };
const oneEach = { tasks: 1, outbox: 1, deliveries: 1 };

const policy: PolicyDecision = {
  effect: 'allow',
  decisionId,
  policyVersion: 'policy-1',
};

const agent: Principal = {
  kind: 'agent',
  agentId: 'researcher',
  version: '1',
  identityRef: 'agent://researcher',
};

const request: TaskSubmit = {
  objective,
  skillId: 'ask',
  input: { incidentId: 'inc-1' },
  sourceAllowlist: ['drive'],
  requestedOutputs: ['answer'],
  executionPolicy: { mode: 'interactive', budgetUsd: 0.1, deadlineSeconds: 30 },
};

const bareRequest: TaskSubmit = {
  objective,
  skillId: 'ask',
  sourceAllowlist: ['drive'],
  requestedOutputs: ['answer'],
  executionPolicy: { mode: 'interactive', budgetUsd: 0.1, deadlineSeconds: 30 },
};

export const acceptInput: AcceptTask = {
  subject: caller,
  idempotencyKey,
  request,
  policy,
  agent,
  deadline,
};

const payload = {
  subject: caller,
  policy,
  agent,
  input: { incidentId: 'inc-1' },
  deadline,
};

type Opened = {
  readonly harness: DispatchHarness;
  readonly dispatch: DispatchPort;
  readonly ledger: TaskLedger;
};

export function dispatchPortContract(create: () => DispatchHarness): void {
  describe('DispatchPort', () => {
    acceptOnce(create);
    omitsMissingInput(create);
    conflictingDeadline(create);
    submitDigestConflicts(create);
    acceptDigestConflicts(create);
    injectedFault(create);
    singleClaim(create);
    sameWorkerMisses(create);
    renewsLiveLease(create);
    expiredLease(create);
    retryAfterRestart(create);
    staleRetry(create);
    releaseClearsLease(create);
    cancelledClaim(create);
    badLeaseWritesNothing(create);
  });
}

function acceptOnce(create: () => DispatchHarness): void {
  it('accepts a task once and claims its delivery', async () => {
    const { harness, dispatch, ledger } = opened(create);
    const first = await dispatch.accept(acceptInput);
    expect(first).toMatchObject({
      status: 'QUEUED',
      submittedAt: startedAt,
      statusUrl: `/v1/tasks/${first.taskId}`,
      traceId: first.taskId.replaceAll('-', ''),
    });
    expect(await harness.counts()).toEqual(oneEach);
    expect(await ledger.readOutbox(`submit:${first.taskId}`)).toEqual(submitted(first.taskId));
    expect(await dispatch.accept(acceptInput)).toEqual(first);
    expect(await harness.counts()).toEqual(oneEach);
    const claimed = await dispatch.claim('worker-a', leaseMs);
    expect(claimed).toMatchObject({
      taskId: first.taskId,
      workerId: 'worker-a',
      fencingToken: 1,
      leaseUntil: leaseEnd,
      attempt: 0,
      payload,
    });
  });
}

function omitsMissingInput(create: () => DispatchHarness): void {
  it('omits input from the delivery when the request has none', async () => {
    const { dispatch } = opened(create);
    await dispatch.accept({ ...acceptInput, idempotencyKey: 'bare-key', request: bareRequest });
    const claimed = await dispatch.claim('worker-a', leaseMs);
    expect(claimed?.payload).toEqual({ subject: caller, policy, agent, deadline });
  });
}

function conflictingDeadline(create: () => DispatchHarness): void {
  it('rejects a different deadline for the same idempotency key', async () => {
    const { harness, dispatch } = opened(create);
    const first = await dispatch.accept(acceptInput);
    await expect(
      dispatch.accept({ ...acceptInput, deadline: otherDeadline }),
    ).rejects.toBeInstanceOf(LedgerConflict);
    expect(await harness.counts()).toEqual(oneEach);
    expect(await dispatch.accept(acceptInput)).toEqual(first);
  });
}

function submitDigestConflicts(create: () => DispatchHarness): void {
  it('rejects accept when submit already claimed the key', async () => {
    const { harness, dispatch, ledger } = opened(create);
    await ledger.submit(caller, request, idempotencyKey);
    await expect(dispatch.accept(acceptInput)).rejects.toBeInstanceOf(LedgerConflict);
    expect(await harness.counts()).toEqual({ tasks: 1, outbox: 0, deliveries: 0 });
  });
}

function acceptDigestConflicts(create: () => DispatchHarness): void {
  it('rejects submit when accept already claimed the key', async () => {
    const { harness, dispatch, ledger } = opened(create);
    const accepted = await dispatch.accept(acceptInput);
    await expect(ledger.submit(caller, request, idempotencyKey)).rejects.toBeInstanceOf(
      LedgerConflict,
    );
    expect(await harness.counts()).toEqual(oneEach);
    expect(await ledger.read(caller, accepted.taskId)).toMatchObject({
      status: 'QUEUED',
      version: 1,
    });
  });
}

function injectedFault(create: () => DispatchHarness): void {
  it('rolls back an accept when the fault fires and then accepts', async () => {
    const { harness, dispatch } = opened(create);
    harness.failNextAcceptAfterTaskInsert();
    await expect(dispatch.accept(acceptInput)).rejects.toBeInstanceOf(DispatchInjectedFault);
    expect(await harness.counts()).toEqual(none);
    const accepted = await dispatch.accept(acceptInput);
    expect(accepted.status).toBe('QUEUED');
    expect(await harness.counts()).toEqual(oneEach);
  });
}

function singleClaim(create: () => DispatchHarness): void {
  it('gives one claim the first token', async () => {
    const { dispatch } = opened(create);
    await dispatch.accept(acceptInput);
    const [left, right] = await Promise.all([
      dispatch.claim('worker-a', leaseMs),
      dispatch.claim('worker-b', leaseMs),
    ]);
    const won = [left, right].filter((item) => item !== undefined);
    expect(won).toHaveLength(1);
    expect(won[0]).toMatchObject({ fencingToken: 1, attempt: 0 });
    expect([left, right].filter((item) => item === undefined)).toHaveLength(1);
  });
}

function sameWorkerMisses(create: () => DispatchHarness): void {
  it('does not refresh a live lease for the same worker', async () => {
    const { dispatch } = opened(create);
    await dispatch.accept(acceptInput);
    const first = await dispatch.claim('worker-a', leaseMs);
    expect(await dispatch.claim('worker-a', leaseMs)).toBeUndefined();
    expect(first).toMatchObject({ fencingToken: 1, workerId: 'worker-a', leaseUntil: leaseEnd });
  });
}

function renewsLiveLease(create: () => DispatchHarness): void {
  it('renews a live lease and keeps the token', async () => {
    const { harness, dispatch } = opened(create);
    await dispatch.accept(acceptInput);
    const claimed = await dispatch.claim('worker-a', leaseMs);
    const renewed = await dispatch.renew(asProof(claimed), 120_000);
    expect(renewed).toMatchObject({
      fencingToken: 1,
      workerId: 'worker-a',
      leaseUntil: renewedUntil,
      attempt: 0,
      payload,
    });
    harness.setNow(leaseEnd);
    expect(await dispatch.claim('worker-b', leaseMs)).toBeUndefined();
  });
}

function expiredLease(create: () => DispatchHarness): void {
  it('lets the next worker claim after the lease ends', async () => {
    const { harness, dispatch } = opened(create);
    await dispatch.accept(acceptInput);
    const claimed = await dispatch.claim('worker-a', leaseMs);
    expect(claimed).toMatchObject({ fencingToken: 1, leaseUntil: leaseEnd, payload });
    harness.setNow(leaseEnd);
    const next = await dispatch.claim('worker-b', leaseMs);
    expect(next).toMatchObject({ fencingToken: 2, workerId: 'worker-b', attempt: 0, payload });
    await expect(dispatch.renew(asProof(claimed), leaseMs)).rejects.toBeInstanceOf(LedgerConflict);
  });
}

function retryAfterRestart(create: () => DispatchHarness): void {
  it('hides a retry until its instant and then claims attempt 2', async () => {
    const { harness, dispatch } = opened(create);
    await dispatch.accept(acceptInput);
    const claimed = await dispatch.claim('worker-a', leaseMs);
    await dispatch.scheduleRetry(asProof(claimed), later, 2);
    const restarted = harness.restart();
    expect(await restarted.dispatch.claim('worker-b', leaseMs)).toBeUndefined();
    harness.setNow(later);
    const again = await restarted.dispatch.claim('worker-b', leaseMs);
    expect(again).toMatchObject({ attempt: 2, fencingToken: 3, payload });
  });
}

function staleRetry(create: () => DispatchHarness): void {
  it('rejects scheduleRetry with a stale token', async () => {
    const { harness, dispatch } = opened(create);
    await dispatch.accept(acceptInput);
    const claimed = await dispatch.claim('worker-a', leaseMs);
    const proof = asProof(claimed);
    await dispatch.scheduleRetry(proof, later, 2);
    await expect(
      dispatch.scheduleRetry(proof, '2026-10-10T10:20:00.000Z', 3),
    ).rejects.toBeInstanceOf(LedgerConflict);
    harness.setNow(later);
    expect(await dispatch.claim('worker-b', leaseMs)).toMatchObject({
      attempt: 2,
      fencingToken: 3,
    });
  });
}

function releaseClearsLease(create: () => DispatchHarness): void {
  it('releases the lease and rejects the old token', async () => {
    const { dispatch } = opened(create);
    await dispatch.accept(acceptInput);
    const claimed = await dispatch.claim('worker-a', leaseMs);
    const proof = asProof(claimed);
    expect(await dispatch.release(proof)).toMatchObject({
      taskId: proof.taskId,
      workerId: 'worker-a',
      fencingToken: 2,
    });
    expect(await dispatch.claim('worker-b', leaseMs)).toMatchObject({
      fencingToken: 3,
      workerId: 'worker-b',
    });
    await expect(dispatch.release(proof)).rejects.toBeInstanceOf(LedgerConflict);
  });
}

function cancelledClaim(create: () => DispatchHarness): void {
  it('returns no claim after the task is cancelled', async () => {
    const { dispatch, ledger } = opened(create);
    const accepted = await dispatch.accept(acceptInput);
    await ledger.transition({
      subject: caller,
      taskId: accepted.taskId,
      expectedVersion: 1,
      to: 'CANCELLED',
      event: transitionEvent('evt-cancel', accepted.taskId),
    });
    expect(await dispatch.claim('worker-a', leaseMs)).toBeUndefined();
    expect(await ledger.read(caller, accepted.taskId)).toMatchObject({
      status: 'CANCELLED',
      version: 2,
    });
  });
}

function badLeaseWritesNothing(create: () => DispatchHarness): void {
  it('rejects a non-positive lease and still issues token 1', async () => {
    const { dispatch } = opened(create);
    await dispatch.accept(acceptInput);
    await expect(dispatch.claim('worker-a', 0)).rejects.toBeInstanceOf(RangeError);
    expect(await dispatch.claim('worker-a', leaseMs)).toMatchObject({
      fencingToken: 1,
      attempt: 0,
    });
  });
}

function opened(create: () => DispatchHarness): Opened {
  const harness = create();
  const ports = harness.open();
  return { harness, dispatch: ports.dispatch, ledger: ports.ledger };
}

function asProof(claimed: ClaimedDelivery | undefined): LeaseProof {
  if (claimed === undefined) throw new Error('missing claim');
  return proofOf(claimed);
}

function submitted(taskId: string): OutboxEvent {
  return {
    destination: 'work',
    event: {
      eventId: `submit:${taskId}`,
      eventType: 'task.submitted',
      schemaVersion: '1',
      occurredAt: startedAt,
      taskId,
      stepId: 'submit',
      traceId: taskId.replaceAll('-', ''),
      initiatorSubject: caller,
      agentPrincipal: 'agent:researcher',
      tool: null,
      policyDecisionId: decisionId,
      approvalId: null,
      requestDigestSha256: canonicalPayloadSha256(request),
      outcome: 'SUCCESS',
      externalObjectRef: null,
      prevDigest: null,
    },
  };
}

function transitionEvent(eventId: string, taskId: string): OutboxEvent {
  return {
    destination: 'work',
    event: {
      eventId,
      eventType: 'task',
      schemaVersion: '1',
      occurredAt: startedAt,
      taskId,
      stepId: 'transition',
      traceId: 'trace',
      initiatorSubject: caller,
      agentPrincipal: 'agent:researcher',
      tool: null,
      policyDecisionId: null,
      approvalId: null,
      requestDigestSha256: null,
      outcome: 'SUCCESS',
      externalObjectRef: null,
      prevDigest: null,
    },
  };
}
