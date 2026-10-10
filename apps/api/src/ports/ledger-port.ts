import type { OutboxEvent, Task, TaskAccepted, TaskSubmit } from '@agent-works/domain';

export class LedgerConflict extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LedgerConflict';
  }
}

export interface LedgerPort {
  submit(request: TaskSubmit, idempotencyKey: string): Promise<TaskAccepted>;
  read(taskId: string): Promise<Task | undefined>;
  append(event: OutboxEvent): Promise<'recorded' | 'replay'>;
}
