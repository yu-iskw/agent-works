import type { ChildGrantRequest, StandingGrant } from './standing-grant-contract.js';

const READ = 'drive.read';

/** Placeholder limits only; real values need the approved O04 policy before live use. */
const budget = {
  approval: 'PLACEHOLDER',
  estimatedCostMicros: 1_000_000,
  inferenceSteps: 40,
  parallelism: 4,
} as const;

export const GRANT_DEPLOYMENT = { region: 'asia-northeast1', governanceZone: 'segment-alpha' };
export const GRANT_NOW = '2026-11-03T00:00:00.000Z';

export const rootGrantFixture: StandingGrant = {
  grantId: 'grant-root',
  issuer: 'local-test:admin',
  sponsor: 'local-test:alice',
  grantee: { botId: 'coordinator', botVersion: 1 },
  permissions: [
    { action: READ, resource: 'drive_research' },
    { action: READ, resource: 'drive_context' },
    { action: 'github.read', resource: 'github_issue' },
  ],
  issuedAt: '2026-11-01T00:00:00.000Z',
  expiresAt: '2026-12-01T00:00:00.000Z',
  revocation: { status: 'active' },
  parentGrantId: null,
  depth: 0,
  maxDepth: 2,
  schedule: {
    allowed: true,
    minIntervalSeconds: 3600,
    maxLifetimeSeconds: 86_400,
    maxActiveRoutines: 3,
  },
  limits: { maxConcurrency: 4, maxFanOut: 5, budget },
  policyRevision: 'policy-r1',
  auditRef: 'audit-grant-root',
};

export const childRequestFixture: ChildGrantRequest = {
  grantId: 'grant-child',
  grantee: { botId: 'research-analyst', botVersion: 3 },
  permissions: [{ action: READ, resource: 'drive_research' }],
  issuedAt: '2026-11-02T00:00:00.000Z',
  expiresAt: '2026-11-15T00:00:00.000Z',
  maxDepth: 2,
  schedule: { allowed: false, minIntervalSeconds: 0, maxLifetimeSeconds: 0, maxActiveRoutines: 0 },
  limits: { maxConcurrency: 2, maxFanOut: 2, budget: { ...budget, estimatedCostMicros: 250_000 } },
  auditRef: 'audit-grant-child',
};
