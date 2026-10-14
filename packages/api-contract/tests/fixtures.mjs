export const submission = {
  kind: 'submit',
  objective: 'Read incident history',
  skillId: 'incident-analysis',
  sourceAllowlist: ['drive'],
  requestedOutputs: ['report'],
  executionPolicy: { mode: 'approval_gated', budgetUsd: 1, deadlineSeconds: 30 },
};
export const task = {
  id: 'task-1',
  createdBySub: 'alice',
  status: 'QUEUED',
  objectiveDigest: 'a'.repeat(64),
  skillVersion: '1.0.0',
  agentVersion: '1.0.0',
  policyVersion: '1.0.0',
  budget: 1,
  version: 1,
  createdAt: '2026-10-14T00:00:00.000Z',
  updatedAt: '2026-10-14T00:00:00.000Z',
};
export const detail = {
  kind: 'detail',
  id: 'approval-1',
  actionSummary: 'Review exact payload',
  requestedBySub: 'alice',
  payloadSha256: 'a'.repeat(64),
  state: 'pending',
  expiresAt: '2027-01-01T00:00:00.000Z',
};
