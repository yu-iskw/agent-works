import type {
  ExternalWriteReceipt,
  OutboxEvent,
  Task,
  TaskAccepted,
  TaskStatus,
  TaskSubmit,
} from '@agent-works/domain';

export class LedgerConflict extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LedgerConflict';
  }
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
