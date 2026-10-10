import * as z from 'zod';

const CREATED = 'CREATED';
const AUTHORIZED = 'AUTHORIZED';
const QUEUED = 'QUEUED';
const RUNNING = 'RUNNING';
const COMPLETED = 'COMPLETED';
const WAITING_APPROVAL = 'WAITING_APPROVAL';
const WAITING_INPUT = 'WAITING_INPUT';
const BLOCKED_AUTH = 'BLOCKED_AUTH';
const PAUSED = 'PAUSED';
const RETRYING = 'RETRYING';
const FAILED = 'FAILED';
const CANCELLED = 'CANCELLED';

export const TASK_STATUSES = [
  CREATED,
  AUTHORIZED,
  QUEUED,
  RUNNING,
  COMPLETED,
  WAITING_APPROVAL,
  WAITING_INPUT,
  BLOCKED_AUTH,
  PAUSED,
  RETRYING,
  FAILED,
  CANCELLED,
] as const;

export const taskStatusSchema = z.enum(TASK_STATUSES);

export type TaskStatus = z.infer<typeof taskStatusSchema>;

export const TRANSITIONS: Record<TaskStatus, readonly TaskStatus[]> = {
  [CREATED]: [AUTHORIZED, CANCELLED],
  [AUTHORIZED]: [QUEUED, CANCELLED],
  [QUEUED]: [RUNNING, CANCELLED],
  [RUNNING]: [
    COMPLETED,
    WAITING_APPROVAL,
    WAITING_INPUT,
    BLOCKED_AUTH,
    PAUSED,
    RETRYING,
    FAILED,
    CANCELLED,
  ],
  [WAITING_APPROVAL]: [RUNNING, CANCELLED],
  [WAITING_INPUT]: [RUNNING, CANCELLED],
  [BLOCKED_AUTH]: [RUNNING, CANCELLED],
  [PAUSED]: [RUNNING, CANCELLED],
  [RETRYING]: [RUNNING, FAILED, CANCELLED],
  [COMPLETED]: [],
  [FAILED]: [],
  [CANCELLED]: [],
};

function targets(status: TaskStatus): readonly TaskStatus[] {
  // eslint-disable-next-line security/detect-object-injection
  return TRANSITIONS[status];
}

export const terminalStatuses: readonly TaskStatus[] = TASK_STATUSES.filter(
  (status) => targets(status).length === 0,
);

export const taskSchema = z.strictObject({
  id: z.string().min(1),
  createdBySub: z.string().min(1),
  status: taskStatusSchema,
  objectiveDigest: z.string().min(1),
  skillVersion: z.string().min(1),
  agentVersion: z.string().min(1),
  policyVersion: z.string().min(1),
  budget: z.number().nonnegative(),
  version: z.number().int().positive(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});

export type Task = z.infer<typeof taskSchema>;

export class IllegalTaskTransition extends Error {
  readonly from: TaskStatus;
  readonly to: TaskStatus;

  constructor(from: TaskStatus, to: TaskStatus) {
    super(`No transition from ${from} to ${to}`);
    this.name = 'IllegalTaskTransition';
    this.from = from;
    this.to = to;
  }
}

export function transition(task: Task, to: TaskStatus): Task {
  if (!targets(task.status).includes(to)) {
    throw new IllegalTaskTransition(task.status, to);
  }
  return { ...task, status: to, version: task.version + 1 };
}
