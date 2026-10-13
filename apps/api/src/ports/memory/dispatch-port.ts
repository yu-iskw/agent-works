import { randomUUID } from 'node:crypto';

import {
  applyLease,
  bodyConflict,
  createDispatchHarness,
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
import { acceptedTask, queuedTask, taskMissing } from '../ledger-port.js';

import {
  cloneSnapshot,
  commitSnapshot,
  createMemoryLedgerPort,
  createMemoryLedgerState,
  memoryClaimKey,
  memoryCounts,
  writeMemoryOutbox,
} from './ledger-port.js';

import type {
  AcceptTask,
  DeliveryRow,
  DispatchHarness,
  DispatchPort,
  DispatchSeam,
  LeaseCommand,
  LeaseDecision,
} from '../dispatch-port.js';
import type { MemoryLedgerState, MemorySnapshot } from './ledger-port.js';
import type {
  ClaimedDelivery,
  DeliveryPayload,
  LeaseProof,
  TaskAccepted,
  TaskStatus,
} from '@agent-works/domain';

const memoryVersion = 'memory';

export function createMemoryDispatchHarness(): DispatchHarness {
  const state = createMemoryLedgerState();
  return createDispatchHarness(
    (now, seam) => ({
      dispatch: createMemoryDispatchPort(state, now, seam),
      ledger: createMemoryLedgerPort(now, state),
    }),
    () => Promise.resolve(memoryCounts(state)),
  );
}
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
    const task = queuedTask(
      randomUUID(),
      parsed.subject,
      parsed.request,
      at.toISOString(),
      memoryVersion,
    );
    const accepted = acceptedTask(task);
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
  const chosen = earliestClaim(state.snapshot, at, workerId, leaseMs);
  if (chosen === undefined) return undefined;
  return commitSnapshot(state, (current) => {
    const next = cloneSnapshot(current);
    next.deliveries.set(chosen.row.taskId, chosen.decision.row);
    return { next, value: chosen.decision.claimed };
  });
}

function earliestClaim(
  snapshot: MemorySnapshot,
  at: Date,
  workerId: string,
  leaseMs: number,
): { row: DeliveryRow; decision: Extract<LeaseDecision, { kind: 'ok' }> } | undefined {
  let chosen: { row: DeliveryRow; decision: Extract<LeaseDecision, { kind: 'ok' }> } | undefined;
  for (const row of snapshot.deliveries.values()) {
    const task = snapshot.tasks.get(row.taskId);
    if (task === undefined) continue;
    const decision = applyLease(row, task.status, { kind: 'claim', workerId, leaseMs }, at);
    if (decision.kind !== 'ok') continue;
    if (chosen !== undefined && compareDeliveries(row, chosen.row) >= 0) continue;
    chosen = { row, decision };
  }
  return chosen;
}

function renewTask(
  state: MemoryLedgerState,
  at: Date,
  lease: LeaseProof,
  leaseMs: number,
): ClaimedDelivery {
  requireLeaseMs(leaseMs);
  const proof = requireProof(lease);
  return commitLease(state, proof.taskId, { kind: 'renew', lease: proof, leaseMs }, at, (claimed) => claimed);
}

function releaseTask(state: MemoryLedgerState, lease: LeaseProof): LeaseProof {
  const proof = requireProof(lease);
  return commitLease(
    state,
    proof.taskId,
    { kind: 'release', lease: proof },
    proofAvailableAt(state, proof.taskId),
    proofOf,
  );
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
  return commitLease(
    state,
    proof.taskId,
    { kind: 'scheduleRetry', lease: proof, at, attempt },
    proofAvailableAt(state, proof.taskId),
    proofOf,
  );
}

function commitLease<T>(
  state: MemoryLedgerState,
  taskId: string,
  command: LeaseCommand,
  at: Date,
  valueOf: (claimed: ClaimedDelivery) => T,
): T {
  return commitSnapshot(state, (current) => {
    const loaded = loadDelivery(current, taskId);
    const decision = applyLease(loaded.row, loaded.status, command, at);
    if (decision.kind !== 'ok') throw leaseConflict();
    const next = cloneSnapshot(current);
    next.deliveries.set(loaded.row.taskId, decision.row);
    return { next, value: valueOf(decision.claimed) };
  });
}

function proofAvailableAt(state: MemoryLedgerState, taskId: string): Date {
  return loadDelivery(state.snapshot, taskId).row.availableAt;
}

function loadDelivery(
  snapshot: MemorySnapshot,
  taskId: string,
): { row: DeliveryRow; status: TaskStatus } {
  const row = snapshot.deliveries.get(taskId);
  const task = snapshot.tasks.get(taskId);
  if (row === undefined || task === undefined) throw taskMissing();
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
    return Promise.reject(error instanceof Error ? error : new Error('task not found'));
  }
}
