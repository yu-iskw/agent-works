import type {
  GraphProjection,
  GraphRevision,
  NodeFacts,
  ProjectionNode,
} from './teamwork-graph-contract.js';

export const FIXTURE_TASK_ID = '11111111-1111-4111-8111-111111111111';
export const FIXTURE_DIGEST = 'a'.repeat(64);
export const FIXTURE_NOW = '2026-11-03T00:00:00.000Z';

export const revisionFixture: GraphRevision = {
  taskId: FIXTURE_TASK_ID,
  revision: 2,
  digest: FIXTURE_DIGEST,
  parentRevision: 1,
  state: 'approved',
};

export function nodeFacts(overrides: Partial<NodeFacts> = {}): NodeFacts {
  return {
    status: 'queued',
    errorCode: null,
    dependenciesSatisfied: true,
    retryNotBefore: null,
    effectUnconfirmed: false,
    now: FIXTURE_NOW,
    ...overrides,
  };
}

export function projectionNode(overrides: Partial<ProjectionNode> = {}): ProjectionNode {
  return {
    key: 'part-1',
    title: 'Compare the options',
    state: 'running',
    reason: null,
    dependsOn: [],
    attempt: 1,
    retryAt: null,
    approval: null,
    updatedAt: FIXTURE_NOW,
    result: null,
    ...overrides,
  };
}

export const projectionFixture: GraphProjection = {
  contractVersion: 'teamwork.graph.v1',
  taskId: FIXTURE_TASK_ID,
  serverRevision: 2,
  taskVersion: 7,
  digest: FIXTURE_DIGEST,
  updatedAt: FIXTURE_NOW,
  nodes: [
    projectionNode({
      key: 'part-1',
      state: 'succeeded',
      result: { href: `/api/tasks/${FIXTURE_TASK_ID}/results/part-1`, label: 'Findings' },
    }),
    projectionNode({
      key: 'part-2',
      state: 'blocked',
      reason: 'prerequisite_pending',
      dependsOn: ['part-1'],
    }),
  ],
};
