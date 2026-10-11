import type { OutboxEvent, Task, TaskAccepted, TaskSubmit } from '@agent-works/domain';

export class LedgerConflict extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LedgerConflict';
  }
}

export interface LedgerPort {
  submit(subject: string, request: TaskSubmit, idempotencyKey: string): Promise<TaskAccepted>;
  read(subject: string, taskId: string): Promise<Task | undefined>;
  append(event: OutboxEvent): Promise<'recorded' | 'replay'>;
  readOutbox(eventId: string): Promise<OutboxEvent | undefined>;
}
