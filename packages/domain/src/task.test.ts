import { assert, constantFrom, property } from 'fast-check';
import { describe, expect, it } from 'vitest';

import {
  IllegalTaskTransition,
  TASK_STATUSES,
  taskSchema,
  terminalStatuses,
  transition,
  type Task,
  type TaskStatus,
} from './task.js';

function terminalStays(from: TaskStatus, to: TaskStatus): boolean {
  const task = taskWith(from);
  try {
    transition(task, to);
  } catch (error: unknown) {
    if (error instanceof IllegalTaskTransition && task.status === from) {
      return true;
    }
    if (error instanceof Error) {
      throw error;
    }
    throw new Error('terminal transition failed');
  }
  return false;
}

function taskWith(status: TaskStatus): Task {
  return taskSchema.parse({
    id: 'tsk_01',
    createdBySub: 'user_sub',
    status,
    objectiveDigest: 'digest',
    skillVersion: 'incident-analysis@1.2.0',
    agentVersion: 'agent@1',
    policyVersion: 'policy@1',
    budget: 5,
    version: 1,
    createdAt: '2026-10-09T09:00:00Z',
    updatedAt: '2026-10-09T09:00:00Z',
  });
}

describe('transition', () => {
  it('moves a created task to authorized and bumps version', () => {
    const created = taskWith('CREATED');
    const authorized = transition(created, 'AUTHORIZED');
    expect(authorized.status).toBe('AUTHORIZED');
    expect(authorized.version).toBe(2);
    expect(created.status).toBe('CREATED');
  });

  it('rejects a random transition out of a terminal state', () => {
    assert(
      property(constantFrom(...terminalStatuses), constantFrom(...TASK_STATUSES), terminalStays),
      { numRuns: 200 },
    );
  });
});
