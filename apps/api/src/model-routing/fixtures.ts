import { readFileSync } from 'node:fs';

import type { ModelIdentity, ApprovedModel, RoutingRule } from '@agent-works/domain/model-policy';
export const defaultIdentity: ModelIdentity = {
  modelId: 'fixture-gemini-default',
  version: 'offline-1',
  region: 'asia-northeast1',
  governanceZone: 'fixture',
};
export const fastIdentity: ModelIdentity = { ...defaultIdentity, modelId: 'fixture-gemini-fast' };
export const approvedDefault: ApprovedModel = {
  ...defaultIdentity,
  costClass: 'standard',
  approvalRef: 'offline-fixture-only',
};
export const approvedFast: ApprovedModel = {
  ...fastIdentity,
  costClass: 'economy',
  approvalRef: 'offline-fixture-only',
};
export const fixtureRule: RoutingRule = {
  ruleId: 'research-fast',
  taskClass: 'research',
  target: fastIdentity,
  fallbacks: [defaultIdentity],
  benchmarkArtifact: 'routing-candidate.json',
};
export const inferenceContext = {
  taskId: 'routing-task',
  traceId: 'routing-trace',
  taskClass: 'research',
  region: 'asia-northeast1',
  governanceZone: 'fixture',
  estimatedCostMicros: 10,
};
export function benchmarkFixture(name: 'baseline' | 'candidate'): unknown {
  return JSON.parse(
    // The path is selected from a typed fixture name under the repository fixtures directory.
    // eslint-disable-next-line security/detect-non-literal-fs-filename
    readFileSync(
      new URL(`../../../../evals/delegation/fixtures/routing-${name}.json`, import.meta.url),
      'utf8',
    ),
  ) as unknown;
}
