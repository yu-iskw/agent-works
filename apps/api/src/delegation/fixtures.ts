import type { DelegationContext } from '../../../../packages/domain/dist/delegation.js';
export const fixtureNow = new Date('2026-10-14T00:00:00.000Z');
export const fixtureLimits = {
  approval: 'PLACEHOLDER' as const,
  estimatedCostMicros: 100,
  inferenceSteps: 10,
  parallelism: 4,
};
export const fixtureContext: DelegationContext = {
  taskId: 'parent',
  rootTaskId: 'parent',
  parentTaskId: null,
  traceId: 'trace-1',
  depth: 0,
  authority: {
    subject: 'alice',
    agentPrincipal: 'agent:orchestrator',
    region: 'asia-northeast1',
    governanceZone: 'fixture',
    grants: [{ capability: 'drive.read', resource: 'source-1' }],
    expiresAt: '2027-01-01T00:00:00.000Z',
    policyDecisionRef: 'policy-1',
  },
  budgetShare: fixtureLimits,
  budgetScope: { taskId: 'parent', userSubject: 'alice', sponsor: 'platform', window: 'fixture' },
};
export const fixtureChild = {
  childTaskId: 'child-1',
  grants: [
    { capability: 'drive.read', resource: 'source-1' },
    { capability: 'email.send', resource: 'attacker' },
  ],
  budgetShare: { ...fixtureLimits, estimatedCostMicros: 60, inferenceSteps: 1, parallelism: 1 },
};
export const fixtureOutput = {
  answer: 'Grounded source text [source-1]',
  citedSourceIds: ['source-1'],
};
