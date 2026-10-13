import { describe, expect, it, vi } from 'vitest';

import { acceptInput } from '../ports/dispatch-port.contract.js';
import { proofOf } from '../ports/dispatch-port.js';

import { createSkillRegistry } from './registry.js';
import { createTaskDispatcher, receiptFor } from './task-dispatcher.js';

import type { RegisteredSkill } from './incident.js';
import type { TaskDispatcherDeps } from './task-dispatcher.js';
import type { DispatchHarness } from '../ports/dispatch-port.js';
import type { OutboxEvent } from '@agent-works/domain';

const origin = '2026-10-10T10:00:00.000Z';
const afterLease = '2026-10-10T10:01:00.000Z';
const afterRetry = '2026-10-10T10:00:01.000Z';
const afterDeadline = '2026-10-10T10:06:00.000Z';
const afterDeadlineRetry = '2026-10-10T10:06:01.000Z';

export function taskDispatcherContract(create: () => DispatchHarness): void {
  describe('durable task dispatcher', () => {
    it('rebuilds skill input and attribution after acceptance restart', async () => {
      const harness = create();
      const accepted = await harness.open().dispatch.accept(acceptInput);
      const ports = harness.restart();
      const dispatch = vi.fn<RegisteredSkill['dispatch']>().mockResolvedValue();
      const worker = createTaskDispatcher({
        ...ports,
        registry: registry(dispatch),
        now: () => new Date(origin),
      });
      expect(await worker.runOnce()).toBe(true);
      expect(dispatch).toHaveBeenCalledWith(
        acceptInput.request,
        accepted,
        {
          caller: { sub: acceptInput.subject, assertion: '' },
          context: acceptInput.context,
          decision: acceptInput.policy,
        },
        expect.objectContaining({
          deadline: Date.parse(acceptInput.deadline),
          signal: expect.any(AbortSignal) as unknown,
        }),
      );
      expect(await ports.ledger.read(acceptInput.subject, accepted.taskId)).toMatchObject({
        status: 'COMPLETED',
        version: 3,
      });
      const events = await ports.ledger.events(acceptInput.subject, accepted.taskId);
      expect(events.map((item) => item.event.eventType).sort()).toEqual([
        'task.completed',
        'task.running',
        'task.submitted',
      ]);
      expect(
        events.every(
          (item) =>
            item.event.initiatorSubject === acceptInput.subject &&
            item.event.agentPrincipal === 'agent:researcher' &&
            item.event.policyDecisionId === acceptInput.policy.decisionId,
        ),
      ).toBe(true);
      expect(await worker.runOnce()).toBe(false);
      expect(dispatch).toHaveBeenCalledOnce();
    });

    it('allows only one concurrent delivery and ignores duplicate terminal work', async () => {
      const harness = create();
      const ports = harness.open();
      const dispatch = vi.fn<RegisteredSkill['dispatch']>().mockResolvedValue();
      const deps = { ...ports, registry: registry(dispatch), now: () => new Date(origin) };
      const accepted = await ports.dispatch.accept(acceptInput);
      const left = createTaskDispatcher({ ...deps, workerId: 'left' });
      const right = createTaskDispatcher({ ...deps, workerId: 'right' });
      expect((await Promise.all([left.runOnce(), right.runOnce()])).sort()).toEqual([false, true]);
      expect(dispatch).toHaveBeenCalledOnce();
      expect(await ports.dispatch.accept({ ...acceptInput, deadline: afterLease })).toEqual(
        accepted,
      );
      expect(await right.runOnce()).toBe(false);
    });

    it('recovers RUNNING after a crash without another RUNNING transition', async () => {
      const harness = create();
      const ports = harness.open();
      const accepted = await ports.dispatch.accept(acceptInput);
      const lease = await ports.dispatch.claim('crashed', 60_000);
      if (lease === undefined) throw new Error('claim');
      await ports.ledger.transition({
        subject: acceptInput.subject,
        taskId: accepted.taskId,
        expectedVersion: 1,
        to: 'RUNNING',
        lease: proofOf(lease),
        event: runningEvent(accepted.taskId),
      });
      harness.setNow(afterLease);
      const restarted = harness.restart();
      const dispatch = vi.fn<RegisteredSkill['dispatch']>().mockResolvedValue();
      await createTaskDispatcher({
        ...restarted,
        registry: registry(dispatch),
        now: () => new Date(afterLease),
      }).runOnce();
      expect(await restarted.ledger.read(acceptInput.subject, accepted.taskId)).toMatchObject({
        status: 'COMPLETED',
        version: 3,
      });
      expect(await restarted.ledger.events(acceptInput.subject, accepted.taskId)).toHaveLength(3);
    });

    it('persists backoff and bounded failures across worker restarts', async () => {
      const harness = create();
      const ports = harness.open();
      const accepted = await ports.dispatch.accept(acceptInput);
      const dispatch = vi
        .fn<RegisteredSkill['dispatch']>()
        .mockRejectedValue(new Error('model offline'));
      const deps = { registry: registry(dispatch), retryMs: 1000, maxAttempts: 2 };
      await createTaskDispatcher({ ...ports, ...deps, now: () => new Date(origin) }).runOnce();
      expect(await ports.ledger.read(acceptInput.subject, accepted.taskId)).toMatchObject({
        status: 'RUNNING',
        version: 2,
      });
      expect(await ports.dispatch.claim('early', 1000)).toBeUndefined();
      harness.setNow(afterRetry);
      const restarted = harness.restart();
      await createTaskDispatcher({
        ...restarted,
        ...deps,
        now: () => new Date(afterRetry),
      }).runOnce();
      expect(await restarted.ledger.read(acceptInput.subject, accepted.taskId)).toMatchObject({
        status: 'FAILED',
        version: 3,
      });
      expect(await restarted.dispatch.claim('later', 1000)).toBeUndefined();
      expect(dispatch).toHaveBeenCalledTimes(2);
    });

    receiptRecovery(create);
    lateReceiptRecovery(create);

    it('parks unavailable or revoked skill authorization', async () => {
      const harness = create();
      const ports = harness.open();
      const accepted = await ports.dispatch.accept(acceptInput);
      await createTaskDispatcher({
        ...ports,
        registry: createSkillRegistry([]),
        now: () => new Date(origin),
      }).runOnce();
      expect(await ports.ledger.read(acceptInput.subject, accepted.taskId)).toMatchObject({
        status: 'BLOCKED_AUTH',
        version: 3,
      });
      expect(await ports.dispatch.claim('next', 1000)).toBeUndefined();
    });

    it('does not overwrite cancellation with a late successful delivery or receipt', async () => {
      const harness = create();
      const ports = harness.open();
      const accepted = await ports.dispatch.accept(acceptInput);
      const dispatch = vi.fn<RegisteredSkill['dispatch']>().mockImplementation(async () => {
        await ports.ledger.transition({
          subject: acceptInput.subject,
          taskId: accepted.taskId,
          expectedVersion: 2,
          to: 'CANCELLED',
          event: {
            ...runningEvent(accepted.taskId),
            event: {
              ...runningEvent(accepted.taskId).event,
              eventId: 'cancelled',
              eventType: 'task.cancelled',
            },
          },
        });
      });
      const skill = {
        ...registered(dispatch),
        result: () => ({ kind: 'written' as const, ticketId: 'late-ticket' }),
      };
      await createTaskDispatcher({
        ...ports,
        registry: createSkillRegistry([skill]),
        now: () => new Date(origin),
      }).runOnce();
      expect(await ports.ledger.read(acceptInput.subject, accepted.taskId)).toMatchObject({
        status: 'CANCELLED',
        version: 3,
      });
      expect(await ports.ledger.readReceipt(acceptInput.subject, accepted.taskId)).toBeUndefined();
      expect(await ports.ledger.readOutbox(`dispatch:${accepted.taskId}:3`)).toBeUndefined();
    });
  });
}

function registered(dispatch: RegisteredSkill['dispatch']): RegisteredSkill {
  return {
    manifest: { id: acceptInput.request.skillId, version: '1', state: 'PUBLISHED', tools: [] },
    validate: () => true,
    dispatch,
  };
}

function registry(dispatch: RegisteredSkill['dispatch']) {
  return createSkillRegistry([registered(dispatch)]);
}

function runningEvent(taskId: string): OutboxEvent {
  return {
    destination: 'work',
    event: {
      eventId: 'running',
      eventType: 'task.running',
      schemaVersion: '1',
      occurredAt: origin,
      taskId,
      stepId: 'dispatch',
      traceId: taskId.replaceAll('-', ''),
      initiatorSubject: acceptInput.subject,
      agentPrincipal: 'agent:researcher',
      tool: null,
      policyDecisionId: acceptInput.policy.decisionId,
      approvalId: null,
      requestDigestSha256: null,
      outcome: 'SUCCESS',
      externalObjectRef: null,
      prevDigest: null,
    },
  };
}

function receiptRecovery(create: () => DispatchHarness): void {
  it('reconciles the original receipt when completion persistence fails after a write', async () => {
    const harness = create();
    const ports = harness.open();
    const accepted = await ports.dispatch.accept(acceptInput);
    const receipt = receiptFor(accepted.taskId, 'ticket-original');
    let external: typeof receipt | undefined;
    const dispatch = vi.fn<RegisteredSkill['dispatch']>().mockImplementation(() => {
      external = receipt;
      return Promise.resolve();
    });
    const skill = {
      ...registered(dispatch),
      result: () =>
        external === undefined ? undefined : { kind: 'written' as const, ticketId: external.ref },
    };
    const transition = ports.ledger.transition.bind(ports.ledger);
    const fault = {
      ...ports.ledger,
      transition: vi
        .fn<typeof transition>()
        .mockImplementation((input) =>
          input.to === 'COMPLETED'
            ? Promise.reject(new Error('database disconnected'))
            : transition(input),
        ),
    };
    await createTaskDispatcher({
      dispatch: ports.dispatch,
      ledger: fault,
      registry: createSkillRegistry([skill]),
      maxAttempts: 1,
      now: () => new Date(origin),
    }).runOnce();
    expect(await ports.ledger.readReceipt(acceptInput.subject, accepted.taskId)).toBeUndefined();
    expect(await ports.ledger.read(acceptInput.subject, accepted.taskId)).toMatchObject({
      status: 'RUNNING',
    });
    harness.setNow(afterRetry);
    const restarted = harness.restart();
    const newDispatch = vi.fn<RegisteredSkill['dispatch']>().mockResolvedValue();
    const reconcile: NonNullable<TaskDispatcherDeps['reconcile']> = () => Promise.resolve(external);
    await createTaskDispatcher({
      ...restarted,
      registry: registry(newDispatch),
      reconcile,
      now: () => new Date(afterRetry),
    }).runOnce();
    expect(newDispatch).not.toHaveBeenCalled();
    expect(dispatch).toHaveBeenCalledOnce();
    expect(await restarted.ledger.readReceipt(acceptInput.subject, accepted.taskId)).toEqual(
      receipt,
    );
    expect(await restarted.ledger.read(acceptInput.subject, accepted.taskId)).toMatchObject({
      status: 'COMPLETED',
    });
    expect(await restarted.ledger.readOutbox(`dispatch:${accepted.taskId}:3`)).toMatchObject({
      event: { externalObjectRef: receipt.ref, tool: 'ticket.create' },
    });
  });

  it('keeps an unavailable receipt store retryable even after the deadline', async () => {
    const harness = create();
    const ports = harness.open();
    const accepted = await ports.dispatch.accept(acceptInput);
    harness.setNow(afterDeadline);
    const dispatch = vi.fn<RegisteredSkill['dispatch']>().mockResolvedValue();
    const reconcile = vi
      .fn<NonNullable<TaskDispatcherDeps['reconcile']>>()
      .mockRejectedValue(new Error('receipt store offline'));
    await createTaskDispatcher({
      ...ports,
      registry: registry(dispatch),
      reconcile,
      maxAttempts: 1,
      now: () => new Date(afterDeadline),
    }).runOnce();
    expect(dispatch).not.toHaveBeenCalled();
    expect(await ports.ledger.read(acceptInput.subject, accepted.taskId)).toMatchObject({
      status: 'RUNNING',
    });
    harness.setNow(afterDeadlineRetry);
    reconcile.mockResolvedValue(receiptFor(accepted.taskId, 'ticket-before-expiry'));
    await createTaskDispatcher({
      ...harness.restart(),
      registry: registry(dispatch),
      reconcile,
      now: () => new Date(afterDeadlineRetry),
    }).runOnce();
    expect(await ports.ledger.readReceipt(acceptInput.subject, accepted.taskId)).toMatchObject({
      ref: 'ticket-before-expiry',
    });
  });
}

function lateReceiptRecovery(create: () => DispatchHarness): void {
  it('preserves a late write receipt and reconciles it after expiry and restart', async () => {
    const harness = create();
    const ports = harness.open();
    const accepted = await ports.dispatch.accept(acceptInput);
    const receipt = receiptFor(accepted.taskId, 'ticket-late');
    let external: typeof receipt | undefined;
    let at = origin;
    let finishWrite = () => {};
    const pendingWrite = new Promise<void>((resolve) => {
      finishWrite = resolve;
    }).then(() => {
      external = receipt;
    });
    const dispatch = vi.fn<RegisteredSkill['dispatch']>().mockImplementation(() => {
      // The skill times out while its external write is still in flight.
      at = acceptInput.deadline;
      harness.setNow(at);
      return Promise.resolve();
    });
    const skill = { ...registered(dispatch), result: () => ({ kind: 'timeout' as const }) };
    const deps = {
      registry: createSkillRegistry([skill]),
      reconcile: vi.fn<NonNullable<TaskDispatcherDeps['reconcile']>>(() =>
        Promise.resolve(external),
      ),
      leaseMs: 600_000,
      maxAttempts: 3,
      now: () => new Date(at),
    };
    await createTaskDispatcher({ ...ports, ...deps }).runOnce();
    expect(await ports.ledger.read(acceptInput.subject, accepted.taskId)).toMatchObject({
      status: 'RUNNING',
      version: 2,
    });
    expect(await ports.dispatch.claim('early', 1000)).toBeUndefined();
    at = '2026-10-10T10:05:01.000Z';
    harness.setNow(at);
    await createTaskDispatcher({ ...harness.restart(), ...deps }).runOnce();
    expect(await ports.ledger.read(acceptInput.subject, accepted.taskId)).toMatchObject({
      status: 'RUNNING',
      version: 2,
    });
    expect(await ports.ledger.readOutbox(`dispatch:${accepted.taskId}:3`)).toBeUndefined();
    finishWrite();
    await pendingWrite;
    at = '2026-10-10T10:05:03.000Z';
    harness.setNow(at);
    await createTaskDispatcher({ ...harness.restart(), ...deps }).runOnce();
    expect(dispatch).toHaveBeenCalledOnce();
    expect(await ports.ledger.read(acceptInput.subject, accepted.taskId)).toMatchObject({
      status: 'COMPLETED',
      version: 3,
    });
    expect(await ports.ledger.readReceipt(acceptInput.subject, accepted.taskId)).toEqual(receipt);
    expect(await ports.ledger.readOutbox(`dispatch:${accepted.taskId}:3`)).toMatchObject({
      event: { eventType: 'task.completed', externalObjectRef: receipt.ref },
    });
  });

  it.each([false, true])(
    'bounds absent-receipt reconciliation after expiry (in-flight write: %s)',
    async (inFlight) => {
      const harness = create();
      const ports = harness.open();
      const accepted = await ports.dispatch.accept(acceptInput);
      let now = inFlight ? origin : afterDeadline;
      const dispatch = vi.fn<RegisteredSkill['dispatch']>().mockImplementation(() => {
        now = afterDeadline;
        harness.setNow(now);
        return Promise.resolve();
      });
      const reconcile = vi
        .fn<NonNullable<TaskDispatcherDeps['reconcile']>>()
        .mockResolvedValue(undefined);
      const skill = { ...registered(dispatch), result: () => ({ kind: 'timeout' as const }) };
      const deps = {
        registry: createSkillRegistry([skill]),
        reconcile,
        maxAttempts: 3,
        leaseMs: 600_000,
        now: () => new Date(now),
      };
      for (const [index, at] of [
        inFlight ? origin : afterDeadline,
        afterDeadlineRetry,
        '2026-10-10T10:06:03.000Z',
      ].entries()) {
        harness.setNow(at);
        now = at;
        await createTaskDispatcher({
          ...harness.restart(),
          ...deps,
        }).runOnce();
        expect(await ports.ledger.read(acceptInput.subject, accepted.taskId)).toMatchObject({
          status: index === 2 ? 'FAILED' : 'RUNNING',
          version: index === 2 ? 3 : 2,
        });
      }
      expect(reconcile).toHaveBeenCalledTimes(inFlight ? 4 : 3);
      expect(dispatch).toHaveBeenCalledTimes(inFlight ? 1 : 0);
      expect(await ports.dispatch.claim('later', 1000)).toBeUndefined();
    },
  );
}
