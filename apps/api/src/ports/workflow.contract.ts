import { describe, expect, it } from 'vitest';

import type { WorkflowPort } from './workflow.js';
import type { WorkflowCheckpoint, WorkflowSignal } from '@agent-works/domain';

const checkpoint: WorkflowCheckpoint = {
  taskId: 'task-1',
  stepId: 'step-1',
  status: 'RUNNING',
};

const resume: WorkflowSignal = {
  taskId: 'task-1',
  signalId: 'sig-1',
  kind: 'resume',
};

export function workflowPortContract(create: () => WorkflowPort): void {
  describe('WorkflowPort', () => {
    it('replaces the checkpoint for a task', async () => {
      const port = create();
      expect(await port.read('task-1')).toBeUndefined();
      expect(await port.save(checkpoint)).toEqual(checkpoint);
      const paused: WorkflowCheckpoint = { ...checkpoint, stepId: 'step-2', status: 'PAUSED' };
      expect(await port.save(paused)).toEqual(paused);
      expect(await port.read('task-1')).toEqual(paused);
    });

    it('records a signal once', async () => {
      const port = create();
      expect(await port.signal(resume)).toBe('recorded');
      expect(await port.signal({ ...resume, kind: 'cancel' })).toBe('duplicate');
      expect(await port.signal({ ...resume, taskId: 'task-2' })).toBe('recorded');
    });
  });
}
