import { randomUUID } from 'node:crypto';

import {
  applyLease,
  bodyConflict,
  DispatchInjectedFault,
  leaseConflict,
  parseAccept,
  proofOf,
  requireAttempt,
  requireInstant,
  requireLeaseMs,
  requireProof,
  submittedEvent,
} from '../dispatch-port.js';
import { LedgerConflict } from '../ledger-port.js';

import {
  cloneSnapshot,
  commitSnapshot,
  createMemoryLedgerPort,
  createMemoryLedgerState,
  memoryAccepted,
  memoryClaimKey,
  memoryCounts,
  memoryTask,
  writeMemoryOutbox,
} from './ledger-port.js';

import type {
  AcceptTask,
  DeliveryRow,
  DispatchHarness,
  DispatchPort,
  DispatchSeam,
} from '../dispatch-port.js';
import type { MemoryLedgerState, MemorySnapshot } from './ledger-port.js';
import type {
  ClaimedDelivery,
  DeliveryPayload,
  LeaseProof,
  TaskAccepted,
  TaskStatus,
} from '@agent-works/domain';

const missingTask = 'task not found';
const origin = '2026-10-10T10:00:00.000Z';

export function createMemoryDispatchPort(
  state: MemoryLedgerState,
  now: () => Date = () => new Date(),
  seam?: DispatchSeam,
): DispatchPort {
  const clock = () => new Date(now().getTime());
  return {
    accept(input) {
      return settle(() => acceptTask(state, clock, seam, input));
    },
    claim(workerId, leaseMs) {
      return settle(() => claimTask(state, clock(), workerId, leaseMs));
    },
    renew(lease, leaseMs) {
      return settle(() => renewTask(state, clock(), lease, leaseMs));
    },
    release(lease) {
      return settle(() => releaseTask(state, lease));
    },
    scheduleRetry(lease, at, attempt) {
      return settle(() => retryTask(state, lease, at, attempt));
    },
  };
}

export function createMemoryDispatchHarness(): DispatchHarness {
  const state = createMemoryLedgerState();
  const seam: DispatchSeam = { failAfterTaskInsert: false };
  let instant = new Date(origin);
  const now = () => instant;
  const open = () => ({
    dispatch: createMemoryDispatchPort(state, now, seam),
    ledger: createMemoryLedgerPort(now, state),
  });
  return {
    open,
    restart: open,
    setNow(iso) {
      instant = new Date(iso);
    },
    failNextAcceptAfterTaskInsert() {
      seam.failAfterTaskInsert = true;
    },
    counts() {
      return Promise.resolve(memoryCounts(state));
    },
  };
}

function acceptTask(
  state: MemoryLedgerState,
  now: () => Date,
  seam: DispatchSeam | undefined,
  input: AcceptTask,
): TaskAccepted {
  const parsed = parseAccept(input);
  const key = memoryClaimKey(parsed.subject, parsed.idempotencyKey);
  const at = now();
  return commitSnapshot(state, (current) => {
    const existing = current.claims.get(key);
    if (existing !== undefined) {
      if (existing.digest !== parsed.digest) throw bodyConflict();
      return { next: current, value: existing.accepted };
    }
    const task = memoryTask(randomUUID(), parsed.subject, parsed.request, at.toISOString());
    const accepted = memoryAccepted(task);
    const next = cloneSnapshot(current);
    next.claims.set(key, { digest: parsed.digest, accepted });
    next.tasks.set(task.id, task);
    if (seam?.failAfterTaskInsert) {
      seam.failAfterTaskInsert = false;
      throw new DispatchInjectedFault();
    }
    writeMemoryOutbox(next, submittedEvent(parsed, task));
    next.deliveries.set(task.id, freshDelivery(task.id, parsed.payload, at));
    return { next, value: accepted };
  });
}

function claimTask(
  state: MemoryLedgerState,
  at: Date,
  workerId: string,
  leaseMs: number,
): ClaimedDelivery | undefined {
  requireLeaseMs(leaseMs);
  const rows = [...state.snapshot.deliveries.values()].sort(compareDeliveries);
  for (const row of rows) {
    const task = state.snapshot.tasks.get(row.taskId);
    if (task === undefined) continue;
    const decision = applyLease(row, task.status, { kind: 'claim', workerId, leaseMs }, at);
    if (decision.kind === 'miss') continue;
    if (decision.kind !== 'ok') throw leaseConflict();
    return commitSnapshot(state, (current) => {
      const next = cloneSnapshot(current);
      next.deliveries.set(row.taskId, decision.row);
      return { next, value: decision.claimed };
    });
  }
  return undefined;
}

function renewTask(
  state: MemoryLedgerState,
  at: Date,
  lease: LeaseProof,
  leaseMs: number,
): ClaimedDelivery {
  requireLeaseMs(leaseMs);
  const proof = requireProof(lease);
  return commitSnapshot(state, (current) => {
    const loaded = loadDelivery(current, proof.taskId);
    const decision = applyLease(
      loaded.row,
      loaded.status,
      { kind: 'renew', lease: proof, leaseMs },
      at,
    );
    if (decision.kind !== 'ok') throw leaseConflict();
    const next = cloneSnapshot(current);
    next.deliveries.set(loaded.row.taskId, decision.row);
    return { next, value: decision.claimed };
  });
}

function releaseTask(state: MemoryLedgerState, lease: LeaseProof): LeaseProof {
  const proof = requireProof(lease);
  return commitSnapshot(state, (current) => {
    const loaded = loadDelivery(current, proof.taskId);
    const decision = applyLease(
      loaded.row,
      loaded.status,
      { kind: 'release', lease: proof },
      loaded.row.availableAt,
    );
    if (decision.kind !== 'ok') throw leaseConflict();
    const next = cloneSnapshot(current);
    next.deliveries.set(loaded.row.taskId, decision.row);
    return { next, value: proofOf(decision.claimed) };
  });
}

function retryTask(
  state: MemoryLedgerState,
  lease: LeaseProof,
  at: string,
  attempt: number,
): LeaseProof {
  requireAttempt(attempt);
  requireInstant(at);
  const proof = requireProof(lease);
  return commitSnapshot(state, (current) => {
    const loaded = loadDelivery(current, proof.taskId);
    const decision = applyLease(
      loaded.row,
      loaded.status,
      { kind: 'scheduleRetry', lease: proof, at, attempt },
      loaded.row.availableAt,
    );
    if (decision.kind !== 'ok') throw leaseConflict();
    const next = cloneSnapshot(current);
    next.deliveries.set(loaded.row.taskId, decision.row);
    return { next, value: proofOf(decision.claimed) };
  });
}

function loadDelivery(
  snapshot: MemorySnapshot,
  taskId: string,
): { row: DeliveryRow; status: TaskStatus } {
  const row = snapshot.deliveries.get(taskId);
  const task = snapshot.tasks.get(taskId);
  if (row === undefined || task === undefined) throw new LedgerConflict(missingTask);
  return { row, status: task.status };
}

function freshDelivery(taskId: string, payload: DeliveryPayload, at: Date): DeliveryRow {
  return {
    taskId,
    payload,
    availableAt: new Date(at.getTime()),
    attempt: 0,
    workerId: undefined,
    leaseUntil: undefined,
    fencingToken: 0,
  };
}

function compareDeliveries(left: DeliveryRow, right: DeliveryRow): number {
  const byTime = left.availableAt.getTime() - right.availableAt.getTime();
  if (byTime !== 0) return byTime;
  if (left.taskId < right.taskId) return -1;
  if (left.taskId > right.taskId) return 1;
  return 0;
}

function settle<T>(run: () => T): Promise<T> {
  try {
    return Promise.resolve(run());
  } catch (error) {
    return Promise.reject(error instanceof Error ? error : new Error(missingTask));
  }
}
