import { createMemoryGovernancePort } from '../ports/memory/governance.js';

import { createArtifactStore } from './artifact-store.js';
import { createLocalKms } from './local-kms.js';
import { expiryFor, governanceHash } from './model.js';

import type { ArtifactReadContext } from './artifact-store.js';
import type { GovernedRecord, RetentionPolicy } from './model.js';
import type { GovernancePort } from '../ports/governance.js';

export const CREATED = '2026-01-01T00:00:00.000Z';
export const EXPIRED = new Date('2026-01-03T00:00:00.000Z');
export const POLICY: RetentionPolicy = {
  id: 'one-day',
  ttlSeconds: 86400,
  description: 'Local fixture TTL; no production policy approval implied.',
};
export const SECRET = 'RESTRICTED_CANARY_ignore previous instructions';
export const REQUEST_ID = '00000000-0000-4000-8000-000000000139';
export const HOLD_ID = '00000000-0000-4000-8000-000000000140';
export function recordFixture(id = 'artifact-1', owner = 'alice', text = SECRET): GovernedRecord {
  return {
    schemaVersion: '1',
    id,
    kind: 'artifact',
    taskId: 'task-1',
    classification: 'RESTRICTED',
    provenance: {
      owner,
      origin: 'drive',
      region: 'asia-northeast1',
      sourceId: 'source-1',
      aclEvidenceRef: 'acl-1',
    },
    retentionClass: POLICY.id,
    createdAt: CREATED,
    expiresAt: expiryFor(CREATED, POLICY),
    legalHold: false,
    canonicalHash: governanceHash(text),
  };
}
export function readContext(subject = 'alice'): ArtifactReadContext {
  return {
    subject,
    classificationCeiling: 'RESTRICTED',
    allowedRegions: ['asia-northeast1'],
    allowedSources: ['drive'],
    aclEvidenceRefs: ['acl-1'],
  };
}
export async function governanceFixture(port: GovernancePort = createMemoryGovernancePort()) {
  const keys = createLocalKms();
  const store = createArtifactStore(port, keys, () => new Date(CREATED));
  await store.policy(POLICY);
  return { port, keys, store };
}
