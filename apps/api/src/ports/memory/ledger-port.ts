import { randomUUID } from 'node:crypto';

import { canonicalPayloadSha256, taskAcceptedSchema, taskSchema } from '@agent-works/domain';

import { LedgerConflict } from '../ledger-port.js';

import type { LedgerPort } from '../ledger-port.js';
import type { Task, TaskAccepted, TaskSubmit } from '@agent-works/domain';

type Stored = {
  readonly digest: string;
  readonly accepted: TaskAccepted;
  readonly task: Task;
};

export function createMemoryLedgerPort(now: () => Date = () => new Date()): LedgerPort {
  const byKey = new Map<string, Stored>();
  const byId = new Map<string, Task>();
  const events = new Map<string, string>();
  return {
    submit(request, idempotencyKey) {
      const digest = canonicalPayloadSha256(request);
      const existing = byKey.get(idempotencyKey);
      if (existing !== undefined) {
        if (existing.digest !== digest)
          return Promise.reject(new LedgerConflict('task body changed'));
        return Promise.resolve(existing.accepted);
      }
      const stored = store(request, digest, now().toISOString());
      byKey.set(idempotencyKey, stored);
      byId.set(stored.task.id, stored.task);
      return Promise.resolve(stored.accepted);
    },
    read(taskId) {
      return Promise.resolve(byId.get(taskId));
    },
    append(event) {
      const digest = canonicalPayloadSha256(event);
      const prior = events.get(event.event.eventId);
      if (prior === undefined) {
        events.set(event.event.eventId, digest);
        return Promise.resolve('recorded');
      }
      if (prior === digest) return Promise.resolve('replay');
      return Promise.reject(new LedgerConflict('outbox event changed'));
    },
  };
}

function store(request: TaskSubmit, digest: string, at: string): Stored {
  const taskId = randomUUID();
  const task = taskSchema.parse({
    id: taskId,
    createdBySub: 'memory',
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
