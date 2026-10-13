import { randomUUID } from 'node:crypto';

import { canonicalPayloadSha256, terminalStatuses } from '@agent-works/domain';

import { principalRef, proofOf } from '../ports/dispatch-port.js';
import { acceptedTask, ConcurrentUpdate, LedgerConflict } from '../ports/ledger-port.js';

import type { RegisteredSkill } from './incident.js';
import type { SkillRegistry } from './registry.js';
import type { Caller } from '../auth/iap.js';
import type { DispatchPort } from '../ports/dispatch-port.js';
import type { TaskLedger } from '../ports/ledger-port.js';
import type {
  ClaimedDelivery,
  ExternalWriteReceipt,
  OutboxEvent,
  Task,
  TaskStatus,
} from '@agent-works/domain';
import type { Delivery } from '@agent-works/incident-analysis';

export type TaskDispatcherDeps = {
  readonly dispatch: DispatchPort;
  readonly ledger: TaskLedger;
  readonly registry: SkillRegistry;
  readonly workerId?: string;
  readonly now?: () => Date;
  readonly leaseMs?: number;
  readonly pollMs?: number;
  readonly retryMs?: number;
  readonly maxAttempts?: number;
  /** Must fail on an unavailable receipt store, rather than report an absent write. */
  readonly reconcile?: (
    delivery: ClaimedDelivery,
    signal: AbortSignal,
  ) => Promise<ExternalWriteReceipt | undefined>;
  readonly onError?: (error: unknown) => void;
};

export type TaskDispatcher = {
  runOnce(signal?: AbortSignal): Promise<boolean>;
  start(this: void): void;
  stop(this: void): Promise<void>;
};

export function createTaskDispatcher(deps: TaskDispatcherDeps): TaskDispatcher {
  const now = deps.now ?? (() => new Date());
  const workerId = deps.workerId ?? randomUUID();
  const leaseMs = deps.leaseMs ?? 30_000;
  const pollMs = deps.pollMs ?? 100;
  const retryMs = deps.retryMs ?? 1000;
  const maxAttempts = deps.maxAttempts ?? 5;
  for (const value of [leaseMs, pollMs, retryMs, maxAttempts]) {
    if (!Number.isInteger(value) || value < 1) throw new RangeError('dispatcher configuration');
  }
  let lifecycle: { controller: AbortController; running: Promise<void> } | undefined;

  async function runOnce(signal?: AbortSignal): Promise<boolean> {
    if (signal?.aborted) return false;
    const delivery = await deps.dispatch.claim(workerId, leaseMs);
    if (delivery === undefined) return false;
    await execute(delivery, signal);
    return true;
  }

  async function execute(delivery: ClaimedDelivery, shutdown?: AbortSignal): Promise<void> {
    const controller = new AbortController();
    const heartbeat = new AbortController();
    const stop = () => controller.abort();
    shutdown?.addEventListener('abort', stop, { once: true });
    if (shutdown?.aborted) stop();
    const pulse = keepLease(delivery, controller, heartbeat.signal);
    try {
      await runDelivery(delivery, controller.signal, shutdown);
    } catch (error) {
      await retryOrFail(delivery, error, shutdown);
    } finally {
      heartbeat.abort();
      await pulse;
      shutdown?.removeEventListener('abort', stop);
      try {
        await deps.dispatch.release(proofOf(delivery));
      } catch (error) {
        if (!isConflict(error)) deps.onError?.(error);
      }
    }
  }

  async function runDelivery(
    delivery: ClaimedDelivery,
    signal: AbortSignal,
    shutdown?: AbortSignal,
  ) {
    let task = await deps.ledger.read(delivery.payload.subject, delivery.taskId);
    if (task === undefined || stopped(task.status)) return;
    if (task.status === 'QUEUED' || task.status === 'RETRYING')
      task = await move(delivery, task, 'RUNNING');
    if (task.status !== 'RUNNING') return;
    const receipt =
      (await deps.ledger.readReceipt(delivery.payload.subject, delivery.taskId)) ??
      (await deps.reconcile?.(delivery, signal));
    if (receipt !== undefined) {
      await move(delivery, task, 'COMPLETED', receipt);
      return;
    }
    signal.throwIfAborted();
    const skill = deps.registry.get(delivery.payload.request.skillId);
    if (!canExecute(skill, delivery)) {
      await move(delivery, task, 'BLOCKED_AUTH');
      return;
    }
    if (now().getTime() >= Date.parse(delivery.payload.deadline)) {
      await move(delivery, task, 'FAILED');
      return;
    }
    await invokeSkill(skill, delivery, task, signal, shutdown);
  }

  async function invokeSkill(
    skill: RegisteredSkill,
    delivery: ClaimedDelivery,
    task: Task,
    signal: AbortSignal,
    shutdown?: AbortSignal,
  ) {
    if (delivery.payload.policy.effect !== 'allow') throw new Error('authorization');
    let failed = false;
    try {
      await abortable(
        skill.dispatch(
          delivery.payload.request,
          acceptedTask(task),
          {
            // Do not persist or replay an expired IAP bearer assertion. Skills use the authorized context.
            caller: { sub: delivery.payload.subject, assertion: '' } as Caller,
            context: delivery.payload.context,
            decision: delivery.payload.policy,
          },
          { deadline: Date.parse(delivery.payload.deadline), signal },
        ),
        signal,
      );
    } catch {
      failed = true;
    }
    if (shutdown?.aborted) throw new Error('dispatcher stopped');
    signal.throwIfAborted();
    await finishDelivery(delivery, task, skillResult(skill, task.id), failed, signal);
  }

  async function finishDelivery(
    delivery: ClaimedDelivery,
    task: Task,
    result: Delivery | undefined,
    failed: boolean,
    signal: AbortSignal,
  ) {
    if (result?.kind === 'written') {
      await move(delivery, task, 'COMPLETED', receiptFor(task.id, result.ticketId));
      return;
    }
    if (result?.kind === 'revoked') {
      await move(delivery, task, 'BLOCKED_AUTH');
      return;
    }
    if (result?.kind === 'cancelled') {
      await move(delivery, task, 'CANCELLED');
      return;
    }
    if (result?.kind === 'timeout' || now().getTime() >= Date.parse(delivery.payload.deadline)) {
      const receipt = await deps.reconcile?.(delivery, signal);
      await move(delivery, task, receipt === undefined ? 'FAILED' : 'COMPLETED', receipt);
      return;
    }
    if (failed || result?.kind === 'failed') {
      const receipt = await deps.reconcile?.(delivery, signal);
      if (receipt !== undefined) {
        await move(delivery, task, 'COMPLETED', receipt);
        return;
      }
      throw new DeliveryFailed();
    }
    await move(delivery, task, 'COMPLETED');
  }

  async function retryOrFail(delivery: ClaimedDelivery, error: unknown, shutdown?: AbortSignal) {
    if (isConflict(error)) return;
    const task = await deps.ledger.read(delivery.payload.subject, delivery.taskId);
    if (task === undefined || stopped(task.status)) return;
    try {
      if (
        error instanceof DeliveryFailed &&
        !shutdown?.aborted &&
        delivery.attempt + 1 >= maxAttempts
      ) {
        await move(delivery, task, 'FAILED');
      } else {
        const backoff = Math.min(retryMs * 2 ** Math.min(delivery.attempt, 16), 60_000);
        await deps.dispatch.scheduleRetry(
          proofOf(delivery),
          new Date(now().getTime() + backoff).toISOString(),
          delivery.attempt + 1,
        );
      }
    } catch (retryError) {
      if (!isConflict(retryError)) throw retryError;
    }
    deps.onError?.(error);
  }

  async function keepLease(
    delivery: ClaimedDelivery,
    controller: AbortController,
    signal: AbortSignal,
  ) {
    try {
      while (!signal.aborted) {
        await pause(Math.max(1, Math.floor(leaseMs / 3)), signal);
        await deps.dispatch.renew(proofOf(delivery), leaseMs);
        const task = await deps.ledger.read(delivery.payload.subject, delivery.taskId);
        if (task === undefined || stopped(task.status)) {
          controller.abort();
          return;
        }
      }
    } catch (error) {
      if (!signal.aborted) {
        controller.abort();
        deps.onError?.(error);
      }
    }
  }

  async function move(
    delivery: ClaimedDelivery,
    task: Task,
    to: TaskStatus,
    receipt?: ExternalWriteReceipt,
  ) {
    return deps.ledger.transition({
      subject: delivery.payload.subject,
      taskId: task.id,
      expectedVersion: task.version,
      to,
      lease: proofOf(delivery),
      receipt,
      event: lifecycleEvent(delivery, task, to, now().toISOString(), receipt),
    });
  }

  async function loop(signal: AbortSignal) {
    while (!signal.aborted) {
      try {
        await runOnce(signal);
      } catch (error) {
        deps.onError?.(error);
      }
      try {
        await pause(pollMs, signal);
      } catch {
        return;
      }
    }
  }

  return {
    runOnce,
    start() {
      if (lifecycle !== undefined) return;
      const controller = new AbortController();
      lifecycle = { controller, running: loop(controller.signal) };
    },
    async stop() {
      const current = lifecycle;
      if (current === undefined) return;
      current.controller.abort();
      await current.running;
      if (lifecycle === current) lifecycle = undefined;
    },
  };
}

function stopped(status: TaskStatus): boolean {
  return terminalStatuses.includes(status) || status === 'BLOCKED_AUTH';
}

function skillResult(skill: RegisteredSkill, taskId: string): Delivery | undefined {
  if ('result' in skill && typeof skill.result === 'function') {
    return (skill.result as (taskId: string) => Delivery | undefined)(taskId);
  }
  return undefined;
}

export function receiptFor(taskId: string, ref: string): ExternalWriteReceipt {
  return { ref, digestSha256: canonicalPayloadSha256({ taskId, ref }) };
}

function lifecycleEvent(
  delivery: ClaimedDelivery,
  task: Task,
  status: TaskStatus,
  at: string,
  receipt?: ExternalWriteReceipt,
): OutboxEvent {
  return {
    destination: 'work',
    event: {
      eventId: `dispatch:${task.id}:${task.version + 1}`,
      eventType: `task.${status.toLowerCase()}`,
      schemaVersion: '1',
      occurredAt: at,
      taskId: task.id,
      stepId: 'dispatch',
      traceId: task.id.replaceAll('-', ''),
      initiatorSubject: delivery.payload.subject,
      agentPrincipal: principalRef(delivery.payload.agent),
      tool: receipt === undefined ? null : 'ticket.create',
      policyDecisionId: delivery.payload.policy.decisionId,
      approvalId: null,
      requestDigestSha256: canonicalPayloadSha256(delivery.payload.request),
      outcome: status === 'FAILED' || status === 'BLOCKED_AUTH' ? 'FAILURE' : 'SUCCESS',
      externalObjectRef: receipt?.ref ?? null,
      prevDigest: null,
    },
  };
}

class DeliveryFailed extends Error {
  constructor() {
    super('delivery failed');
    this.name = 'DeliveryFailed';
  }
}

function isConflict(error: unknown): boolean {
  return error instanceof LedgerConflict || error instanceof ConcurrentUpdate;
}

function canExecute(
  skill: RegisteredSkill | undefined,
  delivery: ClaimedDelivery,
): skill is RegisteredSkill {
  if (skill === undefined || skill.manifest.state !== 'PUBLISHED') return false;
  const agent = delivery.payload.agent;
  if (agent.kind === 'agent' && skill.manifest.version !== agent.version) return false;
  return delivery.payload.policy.effect === 'allow';
}

function pause(ms: number, signal: AbortSignal): Promise<void> {
  return abortable(
    new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        signal.removeEventListener('abort', cancel);
        resolve();
      }, ms);
      const cancel = () => {
        clearTimeout(timer);
      };
      signal.addEventListener('abort', cancel, { once: true });
      if (signal.aborted) cancel();
    }),
    signal,
  );
}

async function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  let abort = () => {};
  const cancelled = new Promise<never>((_resolve, reject) => {
    abort = () => reject(new Error('delivery stopped'));
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort();
  });
  try {
    return await Promise.race([promise, cancelled]);
  } finally {
    signal.removeEventListener('abort', abort);
  }
}
