import { describe, expect, it } from 'vitest';

import { taskAcceptedSchema, taskApiSchema, taskSubmitSchema } from './ledger.js';

const submit = {
  objective: 'Summarize the runbook',
  skillId: 'ask',
  sourceAllowlist: ['drive'],
  requestedOutputs: ['answer'],
  executionPolicy: { mode: 'interactive', budgetUsd: 0.1, deadlineSeconds: 30 },
};

const accepted = {
  taskId: 'task-1',
  status: 'QUEUED' as const,
  submittedAt: '2026-10-10T10:00:00.000Z',
  statusUrl: '/v1/tasks/task-1',
  traceId: 'trace-1',
};

describe('task api', () => {
  it('parses a submit body and an accepted body', () => {
    expect(taskSubmitSchema.parse(submit)).toEqual(submit);
    expect(taskAcceptedSchema.parse(accepted)).toEqual(accepted);
    expect(taskApiSchema.parse({ kind: 'submit', ...submit })).toEqual({
      kind: 'submit',
      ...submit,
    });
  });

  it('accepts optional skill input and unknown-skill rejection', () => {
    const withInput = { ...submit, input: { incidentId: 'inc-1' } };
    expect(taskSubmitSchema.parse(withInput)).toEqual(withInput);
    expect(taskApiSchema.parse({ kind: 'submit', ...withInput })).toEqual({
      kind: 'submit',
      ...withInput,
    });
    expect(taskApiSchema.parse({ error: 'unknown_skill' })).toEqual({ error: 'unknown_skill' });
  });

  it('rejects a client-supplied user id', () => {
    expect(taskSubmitSchema.safeParse({ ...submit, userId: 'alice' }).success).toBe(false);
  });
});
