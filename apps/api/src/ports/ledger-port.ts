import { canonicalPayloadSha256, taskAcceptedSchema, taskSchema } from '@agent-works/domain';

import type {
  ExternalWriteReceipt,
  OutboxEvent,
  Task,
  TaskAccepted,
  TaskStatus,
  TaskSubmit,
} from '@agent-works/domain';

const taskNotFound = 'task not found';

export class LedgerConflict extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LedgerConflict';
  }
}

export function taskMissing(): LedgerConflict {
  return new LedgerConflict(taskNotFound);
}

export function queuedTask(
  taskId: string,
  subject: string,
  request: TaskSubmit,
  at: string,
  versionLabel: string,
): Task {
  return taskSchema.parse({
    id: taskId,
    createdBySub: subject,
    status: 'QUEUED',
    objectiveDigest: canonicalPayloadSha256(request.objective),
    skillVersion: request.skillId,
    agentVersion: versionLabel,
    policyVersion: versionLabel,
    budget: request.executionPolicy.budgetUsd,
    version: 1,
    createdAt: at,
    updatedAt: at,
  });
}

export function acceptedTask(task: Task): TaskAccepted {
  return taskAcceptedSchema.parse({
    taskId: task.id,
    status: 'QUEUED',
    submittedAt: task.createdAt,
    statusUrl: `/v1/tasks/${task.id}`,
    traceId: task.id.replaceAll('-', ''),
  });
}

export class ConcurrentUpdate extends Error {
  constructor() {
    super('stale version');
    this.name = 'ConcurrentUpdate';
  }
}

export type TransitionInput = {
  readonly subject: string;
  readonly taskId: string;
  readonly expectedVersion: number;
  readonly to: TaskStatus;
  readonly event: OutboxEvent;
  readonly receipt?: ExternalWriteReceipt;
};

export interface LedgerPort {
  submit(subject: string, request: TaskSubmit, idempotencyKey: string): Promise<TaskAccepted>;
  read(subject: string, taskId: string): Promise<Task | undefined>;
  append(event: OutboxEvent): Promise<'recorded' | 'replay'>;
  readOutbox(eventId: string): Promise<OutboxEvent | undefined>;
  transition?(input: TransitionInput): Promise<Task>;
  readReceipt?(subject: string, taskId: string): Promise<ExternalWriteReceipt | undefined>;
}

export interface TaskLedger extends LedgerPort {
  transition(input: TransitionInput): Promise<Task>;
  readReceipt(subject: string, taskId: string): Promise<ExternalWriteReceipt | undefined>;
}
