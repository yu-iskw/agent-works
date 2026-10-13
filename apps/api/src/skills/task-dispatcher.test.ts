import { describe, expect, it } from 'vitest';

import { acceptInput } from '../ports/dispatch-port.contract.js';
import { proofOf } from '../ports/dispatch-port.js';
import { LedgerConflict } from '../ports/ledger-port.js';
import { createMemoryDispatchHarness } from '../ports/memory/dispatch-port.js';

import { taskDispatcherContract } from './task-dispatcher.contract.js';

import type { OutboxEvent, TaskStatus } from '@agent-works/domain';

describe('task dispatcher prerequisites', () => {
  it('replays an unchanged request with a fresh policy decision', async () => {
    const harness = createMemoryDispatchHarness();
    const { dispatch } = harness.open();
    const accepted = await dispatch.accept(acceptInput);
    await expect(
      dispatch.accept({
        ...acceptInput,
        policy: {
          ...acceptInput.policy,
          decisionId: '00000000-0000-4000-8000-000000000002',
        },
      }),
    ).resolves.toEqual(accepted);
    expect(await harness.counts()).toEqual({ tasks: 1, outbox: 1, deliveries: 1 });
  });

  it('retains the original deadline on retry', async () => {
    const { dispatch } = createMemoryDispatchHarness().open();
    const accepted = await dispatch.accept(acceptInput);
    await expect(
      dispatch.accept({ ...acceptInput, deadline: '2026-10-10T10:05:01.000Z' }),
    ).resolves.toEqual(accepted);
  });

  it('persists the complete request and authorization after restart', async () => {
    const harness = createMemoryDispatchHarness();
    await harness.open().dispatch.accept(acceptInput);
    const delivery = await harness.restart().dispatch.claim('restarted', 60_000);
    expect(delivery?.payload).toEqual({
      subject: acceptInput.subject,
      policy: acceptInput.policy,
      agent: acceptInput.agent,
      request: acceptInput.request,
      context: acceptInput.context,
      deadline: acceptInput.deadline,
    });
  });

  it('rejects a reclaimed worker with a current task version', async () => {
    const harness = createMemoryDispatchHarness();
    const { dispatch, ledger } = harness.open();
    const accepted = await dispatch.accept(acceptInput);
    const first = await dispatch.claim('old-worker', 60_000);
    if (first === undefined) throw new Error('missing first claim');
    const running = await ledger.transition({
      subject: acceptInput.subject,
      taskId: accepted.taskId,
      expectedVersion: 1,
      lease: proofOf(first),
      to: 'RUNNING',
      event: event(accepted.taskId, 'RUNNING'),
    });
    harness.setNow('2026-10-10T10:01:00.000Z');
    const second = await dispatch.claim('new-worker', 60_000);
    expect(second?.fencingToken).toBeGreaterThan(first.fencingToken);
    await expect(dispatch.renew(proofOf(first), 60_000)).rejects.toBeInstanceOf(LedgerConflict);

    await expect(
      ledger.transition({
        subject: acceptInput.subject,
        taskId: accepted.taskId,
        expectedVersion: running.version,
        lease: proofOf(first),
        to: 'COMPLETED',
        event: event(accepted.taskId, 'COMPLETED'),
        receipt: { ref: 'ticket-old', digestSha256: 'a'.repeat(64) },
      }),
    ).rejects.toBeInstanceOf(LedgerConflict);
    expect(await ledger.readReceipt(acceptInput.subject, accepted.taskId)).toBeUndefined();
    expect(await ledger.readOutbox(`dispatch-gap:${accepted.taskId}:COMPLETED`)).toBeUndefined();
  });

  it('does not automatically claim BLOCKED_AUTH again', async () => {
    const { dispatch, ledger } = createMemoryDispatchHarness().open();
    const accepted = await dispatch.accept(acceptInput);
    const delivery = await dispatch.claim('worker', 60_000);
    if (delivery === undefined) throw new Error('missing claim');
    await ledger.transition({
      subject: acceptInput.subject,
      taskId: accepted.taskId,
      expectedVersion: 1,
      lease: proofOf(delivery),
      to: 'RUNNING',
      event: event(accepted.taskId, 'RUNNING'),
    });
    await ledger.transition({
      subject: acceptInput.subject,
      taskId: accepted.taskId,
      expectedVersion: 2,
      lease: proofOf(delivery),
      to: 'BLOCKED_AUTH',
      event: event(accepted.taskId, 'BLOCKED_AUTH'),
    });
    await dispatch.release(proofOf(delivery));
    expect(await dispatch.claim('another-worker', 60_000)).toBeUndefined();
  });
});

function event(taskId: string, status: TaskStatus): OutboxEvent {
  return {
    destination: 'work',
    event: {
      eventId: `dispatch-gap:${taskId}:${status}`,
      eventType: `task.${status.toLowerCase()}`,
      schemaVersion: '1',
      occurredAt: '2026-10-10T10:00:00.000Z',
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

taskDispatcherContract(createMemoryDispatchHarness);
