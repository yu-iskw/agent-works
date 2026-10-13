import { IllegalTaskTransition } from '@agent-works/domain';
import { describe, expect, it } from 'vitest';

import { ConcurrentUpdate, LedgerConflict } from './ledger-port.js';

import type { TaskLedger } from './ledger-port.js';
import type {
  ExternalWriteReceipt,
  OutboxEvent,
  Task,
  TaskStatus,
  TaskSubmit,
} from '@agent-works/domain';

const caller = 'alice';
const otherCaller = 'bob';
const idempotencyKey = 'key-1';
const occurredAt = '2026-10-10T10:00:00.000Z';
const objective = 'Summarize the runbook';
const memoryAgent = 'agent:memory';
const digestA = 'a'.repeat(64);

const request: TaskSubmit = {
  objective,
  skillId: 'ask',
  sourceAllowlist: ['drive'],
  requestedOutputs: ['answer'],
  executionPolicy: { mode: 'interactive', budgetUsd: 0.1, deadlineSeconds: 30 },
};

const event: OutboxEvent = {
  destination: 'work',
  event: {
    eventId: 'evt-1',
    eventType: 'task',
    schemaVersion: '1',
    occurredAt,
    taskId: 'task-1',
    stepId: 'submit',
    traceId: 'trace',
    initiatorSubject: caller,
    agentPrincipal: memoryAgent,
    tool: null,
    policyDecisionId: null,
    approvalId: null,
    requestDigestSha256: null,
    outcome: 'SUCCESS',
    externalObjectRef: null,
    prevDigest: null,
  },
};

const ticketReceipt: ExternalWriteReceipt = {
  ref: 'TICKET-19',
  digestSha256: digestA,
};

type Move = {
  readonly taskId: string;
  readonly expectedVersion: number;
  readonly to: TaskStatus;
  readonly eventId: string;
  readonly receipt?: ExternalWriteReceipt;
};

export function ledgerPortContract(create: () => TaskLedger): void {
  describe('LedgerPort', () => {
    idempotentSubmit(create);
    isolatedCallers(create);
    changedBody(create);
    outboxReplay(create);
    recordsReceipt(create);
    keepsReceiptOnIllegalFailure(create);
    cancelledStaysCancelled(create);
    failedStaysFailed(create);
    rejectsStaleVersion(create);
    oneWriterWins(create);
  });
}

function idempotentSubmit(create: () => TaskLedger): void {
  it('returns the same accepted task for the same caller and idempotency key', async () => {
    const port = create();
    const first = await port.submit(caller, request, idempotencyKey);
    expect(await port.submit(caller, request, idempotencyKey)).toEqual(first);
    expect(await port.read(caller, first.taskId)).toMatchObject({
      id: first.taskId,
      status: 'QUEUED',
      version: 1,
      createdBySub: caller,
    });
  });
}

function isolatedCallers(create: () => TaskLedger): void {
  it('keeps a second caller on the same key from reading the first task', async () => {
    const port = create();
    const alice = await port.submit(caller, request, idempotencyKey);
    const bob = await port.submit(otherCaller, request, idempotencyKey);
    expect(bob.taskId).not.toBe(alice.taskId);
    expect(await port.read(otherCaller, alice.taskId)).toBeUndefined();
  });
}

function changedBody(create: () => TaskLedger): void {
  it('rejects a second body for the same caller and idempotency key', async () => {
    const port = create();
    await port.submit(caller, request, idempotencyKey);
    await expect(
      port.submit(caller, { ...request, objective: 'A different objective' }, idempotencyKey),
    ).rejects.toBeInstanceOf(LedgerConflict);
  });
}

function outboxReplay(create: () => TaskLedger): void {
  it('records an outbox event once and replays the same body', async () => {
    const port = create();
    expect(await port.readOutbox(event.event.eventId)).toBeUndefined();
    expect(await port.append(event)).toBe('recorded');
    expect(await port.readOutbox(event.event.eventId)).toEqual(event);
    expect(await port.append(event)).toBe('replay');
    await expect(
      port.append({ ...event, event: { ...event.event, outcome: 'CHANGED' } }),
    ).rejects.toBeInstanceOf(LedgerConflict);
  });
}

function recordsReceipt(create: () => TaskLedger): void {
  it('stores the receipt for the completed version and both outbox events', async () => {
    const port = create();
    const runningId = 'evt-running';
    const completedId = 'evt-completed';
    const accepted = await port.submit(caller, request, 'receipt-key');
    await move(port, {
      taskId: accepted.taskId,
      expectedVersion: 1,
      to: 'RUNNING',
      eventId: runningId,
    });
    const completed = await move(port, {
      taskId: accepted.taskId,
      expectedVersion: 2,
      to: 'COMPLETED',
      eventId: completedId,
      receipt: ticketReceipt,
    });
    expect(completed).toMatchObject({ status: 'COMPLETED', version: 3 });
    expect(await port.readReceipt(caller, accepted.taskId)).toEqual(ticketReceipt);
    expect(await port.readOutbox(runningId)).toEqual(workEvent(runningId, accepted.taskId));
    expect(await port.readOutbox(completedId)).toEqual(workEvent(completedId, accepted.taskId));
  });
}

function keepsReceiptOnIllegalFailure(create: () => TaskLedger): void {
  it('leaves the receipt in place when a completed task cannot fail', async () => {
    const port = create();
    const illegalId = 'evt-after-done';
    const accepted = await port.submit(caller, request, 'completed-key');
    await move(port, {
      taskId: accepted.taskId,
      expectedVersion: 1,
      to: 'RUNNING',
      eventId: 'evt-run-done',
    });
    await move(port, {
      taskId: accepted.taskId,
      expectedVersion: 2,
      to: 'COMPLETED',
      eventId: 'evt-done',
      receipt: ticketReceipt,
    });
    await expect(
      move(port, { taskId: accepted.taskId, expectedVersion: 3, to: 'FAILED', eventId: illegalId }),
    ).rejects.toBeInstanceOf(IllegalTaskTransition);
    expect(await port.readOutbox(illegalId)).toBeUndefined();
    expect(await port.read(caller, accepted.taskId)).toMatchObject({
      status: 'COMPLETED',
      version: 3,
    });
    expect(await port.readReceipt(caller, accepted.taskId)).toEqual(ticketReceipt);
  });
}

function cancelledStaysCancelled(create: () => TaskLedger): void {
  it('rejects completion of a cancelled task and stores no receipt', async () => {
    const port = create();
    const illegalId = 'evt-cancel-done';
    const accepted = await port.submit(caller, request, 'cancel-key');
    await move(port, {
      taskId: accepted.taskId,
      expectedVersion: 1,
      to: 'CANCELLED',
      eventId: 'evt-cancel',
    });
    await expect(
      move(port, {
        taskId: accepted.taskId,
        expectedVersion: 2,
        to: 'COMPLETED',
        eventId: illegalId,
        receipt: ticketReceipt,
      }),
    ).rejects.toBeInstanceOf(IllegalTaskTransition);
    expect(await port.readOutbox(illegalId)).toBeUndefined();
    expect(await port.readReceipt(caller, accepted.taskId)).toBeUndefined();
    expect(await port.read(caller, accepted.taskId)).toMatchObject({
      status: 'CANCELLED',
      version: 2,
    });
  });
}

function failedStaysFailed(create: () => TaskLedger): void {
  it('rejects completion after failure and writes no success outbox', async () => {
    const port = create();
    const failedId = 'evt-failed';
    const successId = 'evt-success';
    const accepted = await port.submit(caller, request, 'failed-key');
    await move(port, {
      taskId: accepted.taskId,
      expectedVersion: 1,
      to: 'RUNNING',
      eventId: 'evt-run-fail',
    });
    await move(port, {
      taskId: accepted.taskId,
      expectedVersion: 2,
      to: 'FAILED',
      eventId: failedId,
    });
    await expect(
      move(port, {
        taskId: accepted.taskId,
        expectedVersion: 3,
        to: 'COMPLETED',
        eventId: successId,
        receipt: ticketReceipt,
      }),
    ).rejects.toBeInstanceOf(IllegalTaskTransition);
    expect(await port.readOutbox(successId)).toBeUndefined();
    expect(await port.readOutbox(failedId)).toEqual(workEvent(failedId, accepted.taskId));
    expect(await port.read(caller, accepted.taskId)).toMatchObject({
      status: 'FAILED',
      version: 3,
    });
  });
}

function rejectsStaleVersion(create: () => TaskLedger): void {
  it('rejects an expected version the new task has not reached', async () => {
    const port = create();
    const staleId = 'evt-stale';
    const accepted = await port.submit(caller, request, 'stale-key');
    await expect(
      move(port, { taskId: accepted.taskId, expectedVersion: 2, to: 'RUNNING', eventId: staleId }),
    ).rejects.toBeInstanceOf(ConcurrentUpdate);
    expect(await port.read(caller, accepted.taskId)).toMatchObject({
      status: 'QUEUED',
      version: 1,
    });
    expect(await port.readOutbox(staleId)).toBeUndefined();
  });
}

function oneWriterWins(create: () => TaskLedger): void {
  it('lets one of two version 1 transitions win', async () => {
    const port = create();
    const accepted = await port.submit(caller, request, 'race-key');
    const results = await Promise.allSettled([
      move(port, {
        taskId: accepted.taskId,
        expectedVersion: 1,
        to: 'RUNNING',
        eventId: 'evt-race-a',
      }),
      move(port, {
        taskId: accepted.taskId,
        expectedVersion: 1,
        to: 'RUNNING',
        eventId: 'evt-race-b',
      }),
    ]);
    const fulfilled = results.find((result) => result.status === 'fulfilled');
    const rejected = results.find((result) => result.status === 'rejected');
    expect(fulfilled?.status).toBe('fulfilled');
    expect(rejected?.status === 'rejected' ? rejected.reason : undefined).toBeInstanceOf(
      ConcurrentUpdate,
    );
    expect(await port.read(caller, accepted.taskId)).toMatchObject({
      status: 'RUNNING',
      version: 2,
    });
  });
}

function move(port: TaskLedger, input: Move): Promise<Task> {
  return port.transition({
    subject: caller,
    taskId: input.taskId,
    expectedVersion: input.expectedVersion,
    to: input.to,
    event: workEvent(input.eventId, input.taskId),
    ...(input.receipt === undefined ? {} : { receipt: input.receipt }),
  });
}

function workEvent(eventId: string, taskId: string): OutboxEvent {
  return {
    destination: 'work',
    event: {
      eventId,
      eventType: 'task',
      schemaVersion: '1',
      occurredAt,
      taskId,
      stepId: 'transition',
      traceId: 'trace',
      initiatorSubject: caller,
      agentPrincipal: memoryAgent,
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
