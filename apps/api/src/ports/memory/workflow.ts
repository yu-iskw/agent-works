import { workflowCheckpointSchema, workflowSignalSchema } from '@agent-works/domain';

import type { WorkflowPort } from '../workflow.js';
import type { WorkflowCheckpoint } from '@agent-works/domain';

export function createMemoryWorkflowPort(): WorkflowPort {
  const checkpoints = new Map<string, WorkflowCheckpoint>();
  const signals = new Set<string>();
  return {
    save(checkpoint) {
      const parsed = workflowCheckpointSchema.parse(checkpoint);
      checkpoints.set(parsed.taskId, parsed);
      return Promise.resolve(parsed);
    },
    read(taskId) {
      return Promise.resolve(checkpoints.get(taskId));
    },
    signal(signal) {
      const parsed = workflowSignalSchema.parse(signal);
      const key = `${parsed.taskId}\0${parsed.signalId}`;
      if (signals.has(key)) return Promise.resolve('duplicate');
      signals.add(key);
      return Promise.resolve('recorded');
    },
  };
}
