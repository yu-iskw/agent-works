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

describe('approvalSchema', () => {
  it('schema-rejects-missing-tool', () => {
    const { tool, ...rest } = validApproval;
    expect(tool).toBe('jira.issue.create@1.0.0');
    expect(approvalSchema.safeParse(rest).success).toBe(false);
  });

  it('schema-rejects-missing-target', () => {
    const { targetResource, ...rest } = validApproval;
    expect(targetResource).toBe('PROJ');
    expect(approvalSchema.safeParse(rest).success).toBe(false);
  });

  it('schema-rejects-missing-max-executions', () => {
    const { maxExecutions, ...rest } = validApproval;
    expect(maxExecutions).toBe(1);
    expect(approvalSchema.safeParse(rest).success).toBe(false);
  });

  it('rejects a used count above the cap', () => {
    expect(approvalSchema.safeParse({ ...validApproval, executionsUsed: 2 }).success).toBe(false);
  });
});
