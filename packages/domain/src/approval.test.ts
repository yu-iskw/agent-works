import { describe, expect, it } from 'vitest';

import { approvalSchema } from './approval.js';

const validApproval = {
  id: 'apr_01',
  taskId: 'tsk_01',
  stepId: 'step_0003',
  tool: 'jira.issue.create@1.0.0',
  targetResource: 'PROJ',
  payloadSha256: 'a'.repeat(64),
  requestedBySub: 'user_sub',
  approverSub: null,
  state: 'pending',
  expiresAt: '2026-10-11T00:00:00Z',
  maxExecutions: 1,
  executionsUsed: 0,
};

function without(key: keyof typeof validApproval): Record<string, unknown> {
  return Object.fromEntries(Object.entries(validApproval).filter(([name]) => name !== key));
}

describe('approvalSchema', () => {
  it('schema-rejects-missing-tool', () => {
    expect(approvalSchema.safeParse(without('tool')).success).toBe(false);
  });

  it('schema-rejects-missing-target', () => {
    expect(approvalSchema.safeParse(without('targetResource')).success).toBe(false);
  });

  it('schema-rejects-missing-max-executions', () => {
    expect(approvalSchema.safeParse(without('maxExecutions')).success).toBe(false);
  });

  it('rejects a used count above the cap', () => {
    expect(approvalSchema.safeParse({ ...validApproval, executionsUsed: 2 }).success).toBe(false);
  });
});
