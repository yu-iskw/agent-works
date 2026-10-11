import type { WorkflowCheckpoint, WorkflowSignal } from '@agent-works/domain';

export interface WorkflowPort {
  save(checkpoint: WorkflowCheckpoint): Promise<WorkflowCheckpoint>;
  read(taskId: string): Promise<WorkflowCheckpoint | undefined>;
  signal(signal: WorkflowSignal): Promise<'recorded' | 'duplicate'>;
}
