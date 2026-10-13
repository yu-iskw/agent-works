import { randomUUID } from 'node:crypto';

import { canonicalPayloadSha256, externalWriteReceipt, transition } from '@agent-works/domain';

import {
  acceptedTask,
  bodyConflict,
  ConcurrentUpdate,
  LedgerConflict,
  queuedTask,
  taskMissing,
} from '../ledger-port.js';

import type { DeliveryRow } from '../dispatch-port.js';
import type { TaskLedger, TransitionInput } from '../ledger-port.js';
import type {
  ExternalWriteReceipt,
  OutboxEvent,
  Task,
  TaskAccepted,
  TaskSubmit,
} from '@agent-works/domain';

const memoryVersion = 'memory';
const changedEvent = 'outbox event changed';

type MemoryClaim = {
  readonly digest: string;
  readonly accepted: TaskAccepted;
};

export type MemorySnapshot = {
  readonly claims: ReadonlyMap<string, MemoryClaim>;
  readonly tasks: ReadonlyMap<string, Task>;
  readonly events: ReadonlyMap<string, OutboxEvent>;
  readonly deliveries: ReadonlyMap<string, DeliveryRow>;
  readonly receipts: ReadonlyMap<string, ExternalWriteReceipt>;
};

export type MemoryDraft = {
  claims: Map<string, MemoryClaim>;
  tasks: Map<string, Task>;
  events: Map<string, OutboxEvent>;
  deliveries: Map<string, DeliveryRow>;
  receipts: Map<string, ExternalWriteReceipt>;
};

export type MemoryLedgerState = {
  snapshot: MemorySnapshot;
};

export function createMemoryLedgerState(): MemoryLedgerState {
  return {
    snapshot: {
      claims: new Map(),
      tasks: new Map(),
      events: new Map(),
      deliveries: new Map(),
      receipts: new Map(),
    },
  };
}

export function cloneSnapshot(snapshot: MemorySnapshot): MemoryDraft {
  return {
    claims: new Map(snapshot.claims),
    tasks: new Map(snapshot.tasks),
    events: new Map(snapshot.events),
    deliveries: new Map(snapshot.deliveries),
    receipts: new Map(snapshot.receipts),
  };
}

export function commitSnapshot<T>(
  state: MemoryLedgerState,
  produce: (current: MemorySnapshot) => { next: MemorySnapshot; value: T },
): T {
  const produced = produce(state.snapshot);
  if (produced.next !== state.snapshot) state.snapshot = produced.next;
  return produced.value;
}

export function memoryCounts(state: MemoryLedgerState): {
  tasks: number;
  outbox: number;
  deliveries: number;
} {
  return {
    tasks: state.snapshot.tasks.size,
    outbox: state.snapshot.events.size,
    deliveries: state.snapshot.deliveries.size,
  };
}

export function memoryClaimKey(subject: string, idempotencyKey: string): string {
  return `${subject}\0${idempotencyKey}`;
}

export function writeMemoryOutbox(draft: MemoryDraft, event: OutboxEvent): void {
  const digest = canonicalPayloadSha256(event);
  const prior = draft.events.get(event.event.eventId);
  if (prior === undefined) {
    draft.events.set(event.event.eventId, structuredClone(event));
    return;
  }
  if (canonicalPayloadSha256(prior) === digest) return;
  throw new LedgerConflict(changedEvent);
}

export function createMemoryLedgerPort(
  now: () => Date = () => new Date(),
  state: MemoryLedgerState = createMemoryLedgerState(),
): TaskLedger {
  return {
    submit(subject, request, idempotencyKey) {
      return settle(() => submitTask(state, now, subject, request, idempotencyKey));
    },
    read(subject, taskId) {
      return Promise.resolve(readTask(state, subject, taskId));
    },
    append(event) {
      return settle(() => appendEvent(state, event));
    },
    readOutbox(eventId) {
      return Promise.resolve(readEvent(state, eventId));
    },
    transition(input) {
      return settle(() => transitionTask(state, now, input));
    },
    readReceipt(subject, taskId) {
      return Promise.resolve(readReceipt(state, subject, taskId));
    },
  };
}

function submitTask(
  state: MemoryLedgerState,
  now: () => Date,
  subject: string,
  request: TaskSubmit,
  idempotencyKey: string,
): TaskAccepted {
  const digest = canonicalPayloadSha256(request);
  const key = memoryClaimKey(subject, idempotencyKey);
  return commitSnapshot(state, (current) => {
    const existing = current.claims.get(key);
    if (existing !== undefined) {
      if (existing.digest !== digest) throw bodyConflict();
      return { next: current, value: existing.accepted };
    }
    const at = now().toISOString();
    const task = queuedTask(randomUUID(), subject, request, at, memoryVersion);
    const accepted = acceptedTask(task);
    const next = cloneSnapshot(current);
    next.claims.set(key, { digest, accepted });
    next.tasks.set(task.id, task);
    return { next, value: accepted };
  });
}

function readTask(state: MemoryLedgerState, subject: string, taskId: string): Task | undefined {
  const task = state.snapshot.tasks.get(taskId);
  if (task === undefined || task.createdBySub !== subject) return undefined;
  return task;
}

function appendEvent(state: MemoryLedgerState, event: OutboxEvent): 'recorded' | 'replay' {
  return commitSnapshot(state, (current) => {
    const prior = current.events.get(event.event.eventId);
    if (prior !== undefined && canonicalPayloadSha256(prior) === canonicalPayloadSha256(event)) {
      return { next: current, value: 'replay' };
    }
    const next = cloneSnapshot(current);
    writeMemoryOutbox(next, event);
    return { next, value: 'recorded' };
  });
}

function readEvent(state: MemoryLedgerState, eventId: string): OutboxEvent | undefined {
  const stored = state.snapshot.events.get(eventId);
  if (stored === undefined) return undefined;
  return structuredClone(stored);
}

function transitionTask(state: MemoryLedgerState, now: () => Date, input: TransitionInput): Task {
  const receipt = input.receipt === undefined ? undefined : externalWriteReceipt(input.receipt);
  const at = now().toISOString();
  return commitSnapshot(state, (current) => {
    const task = current.tasks.get(input.taskId);
    if (task === undefined || task.createdBySub !== input.subject) throw taskMissing();
    if (task.version !== input.expectedVersion) throw new ConcurrentUpdate();
    const updated = { ...transition(task, input.to), updatedAt: at };
    const next = cloneSnapshot(current);
    next.tasks.set(task.id, updated);
    if (receipt !== undefined) next.receipts.set(receiptKey(task.id, updated.version), receipt);
    writeMemoryOutbox(next, input.event);
    return { next, value: updated };
  });
}

function readReceipt(
  state: MemoryLedgerState,
  subject: string,
  taskId: string,
): ExternalWriteReceipt | undefined {
  const task = readTask(state, subject, taskId);
  if (task === undefined) return undefined;
  const stored = state.snapshot.receipts.get(receiptKey(taskId, task.version));
  if (stored === undefined) return undefined;
  return externalWriteReceipt(stored);
}

function receiptKey(taskId: string, version: number): string {
  return `${taskId}\0${version}`;
}

function settle<T>(run: () => T): Promise<T> {
  try {
    return Promise.resolve(run());
  } catch (error) {
    return Promise.reject(error instanceof Error ? error : new Error(memoryVersion));
  }
}
