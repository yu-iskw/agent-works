import { randomUUID } from 'node:crypto';

import { canonicalPayloadSha256, taskAcceptedSchema, taskSchema } from '@agent-works/domain';

import { LedgerConflict } from '../ledger-port.js';

import type { LedgerPort } from '../ledger-port.js';
import type { OutboxEvent, Task, TaskAccepted, TaskSubmit } from '@agent-works/domain';

type Stored = {
  readonly digest: string;
  readonly accepted: TaskAccepted;
  readonly task: Task;
};

export function createMemoryLedgerPort(now: () => Date = () => new Date()): LedgerPort {
  const byKey = new Map<string, Stored>();
  const byId = new Map<string, Task>();
  const events = new Map<string, OutboxEvent>();
  return {
    submit(subject, request, idempotencyKey) {
      const digest = canonicalPayloadSha256(request);
      const existing = byKey.get(claimKey(subject, idempotencyKey));
      if (existing !== undefined) {
        if (existing.digest !== digest) {
          return Promise.reject(new LedgerConflict('task body changed'));
        }
        return Promise.resolve(existing.accepted);
      }
      const stored = store(subject, request, digest, now().toISOString());
      byKey.set(claimKey(subject, idempotencyKey), stored);
      byId.set(stored.task.id, stored.task);
      return Promise.resolve(stored.accepted);
    },
    read(subject, taskId) {
      const task = byId.get(taskId);
      if (task === undefined || task.createdBySub !== subject) return Promise.resolve(undefined);
      return Promise.resolve(task);
    },
    append(event) {
      const digest = canonicalPayloadSha256(event);
      const prior = events.get(event.event.eventId);
      if (prior === undefined) {
        events.set(event.event.eventId, structuredClone(event));
        return Promise.resolve('recorded');
      }
      if (canonicalPayloadSha256(prior) === digest) return Promise.resolve('replay');
      return Promise.reject(new LedgerConflict('outbox event changed'));
    },
    readOutbox(eventId) {
      return Promise.resolve(structuredClone(events.get(eventId)));
    },
  };
}

function claimKey(subject: string, idempotencyKey: string): string {
  return `${subject}\0${idempotencyKey}`;
}

function store(subject: string, request: TaskSubmit, digest: string, at: string): Stored {
  const taskId = randomUUID();
  const task = taskSchema.parse({
    id: taskId,
    createdBySub: subject,
    status: 'QUEUED',
    objectiveDigest: canonicalPayloadSha256(request.objective),
    skillVersion: request.skillId,
    agentVersion: 'memory',
    policyVersion: 'memory',
    budget: request.executionPolicy.budgetUsd,
    version: 1,
    createdAt: at,
    updatedAt: at,
  });
  const accepted = taskAcceptedSchema.parse({
    taskId,
    status: 'QUEUED',
    submittedAt: at,
    statusUrl: `/v1/tasks/${taskId}`,
    traceId: taskId.replaceAll('-', ''),
  });
  return { digest, accepted, task };
}
