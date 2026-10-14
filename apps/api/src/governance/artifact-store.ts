import {
  expiryFor,
  governanceHash,
  governedRecordSchema,
  permitsClassification,
  retentionPolicySchema,
} from '@agent-works/domain/data-governance';

import { GovernanceConflict } from '../ports/governance.js';

import { decryptArtifact, encryptArtifact, encryptPayload } from './encryption.js';
import { isHeld } from './holds.js';

import type { KeyProvider } from '../ports/governance-key-provider.js';
import type { GovernancePort } from '../ports/governance.js';
import type {
  DerivedRow,
  GovernanceClassification,
  GovernedArtifact,
  GovernedRecord,
  RetentionPolicy,
} from '@agent-works/domain/data-governance';

export type ArtifactReadContext = {
  readonly subject: string;
  readonly classificationCeiling: GovernanceClassification;
  readonly allowedRegions: readonly string[];
  readonly allowedSources: readonly string[];
  readonly aclEvidenceRefs: readonly string[];
};
export type ArtifactStore = {
  policy(policy: RetentionPolicy): Promise<void>;
  put(record: GovernedRecord, text: string): Promise<GovernedArtifact>;
  derive(parentId: string, id: string, kind: DerivedRow['kind'], text: string): Promise<void>;
  read(id: string, context: ArtifactReadContext): Promise<string | undefined>;
};
export function createArtifactStore(
  port: GovernancePort,
  keys: KeyProvider,
  now: () => Date,
): ArtifactStore {
  return {
    async policy(input) {
      const policy = retentionPolicySchema.parse(input);
      await port.transact((state) => {
        const previous = state.policies.find((row) => row.id === policy.id);
        if (previous !== undefined && governanceHash(previous) !== governanceHash(policy))
          throw new GovernanceConflict('retention policy immutable');
        if (previous === undefined) state.policies.push(policy);
      });
    },
    async put(input, text) {
      const record = governedRecordSchema.parse(input);
      const envelope = await encryptArtifact(keys, record, text);
      return port.transact((state) => {
        const policy = state.policies.find((row) => row.id === record.retentionClass);
        if (policy === undefined || expiryFor(record.createdAt, policy) !== record.expiresAt)
          throw new GovernanceConflict('retention mismatch');
        if (state.tombstones.some((row) => row.recordId === record.id))
          throw new GovernanceConflict('record deleted');
        if (state.revokedSources.includes(record.provenance.sourceId))
          throw new GovernanceConflict('source revoked');
        if (
          state.requests.some(
            (row) => row.subject === record.provenance.owner && row.state !== 'REJECTED',
          )
        )
          throw new GovernanceConflict('owner deletion fence');
        const prior = state.artifacts.find((row) => row.record.id === record.id);
        if (prior !== undefined) {
          const normalized = { ...record, legalHold: prior.record.legalHold };
          if (governanceHash(normalized) !== governanceHash(prior.record))
            throw new GovernanceConflict('artifact id reused');
          return prior;
        }
        record.legalHold = isHeld(state, record);
        const artifact = { record, envelope };
        state.artifacts.push(artifact);
        return artifact;
      });
    },
    async derive(parentId, id, kind, text) {
      const envelope = await encryptPayload(keys, governanceHash({ parentId, id, kind }), text);
      await port.transact((state) => {
        const parent = state.artifacts.find((row) => row.record.id === parentId);
        if (
          parent === undefined ||
          Date.parse(parent.record.expiresAt) <= now().getTime() ||
          state.revokedSources.includes(parent.record.provenance.sourceId)
        )
          throw new GovernanceConflict('parent unavailable');
        if (
          state.requests.some(
            (row) => row.subject === parent.record.provenance.owner && row.state !== 'REJECTED',
          )
        )
          throw new GovernanceConflict('owner deletion fence');
        if (state.derived.some((row) => row.id === id))
          throw new GovernanceConflict('derived id reused');
        state.derived.push({ parentId, id, kind, envelope });
      });
    },
    async read(id, context) {
      // The transaction keeps hold/deletion/intake decisions consistent through decryption.
      return port.transact(async (state) => {
        const artifact = state.artifacts.find((row) => row.record.id === id);
        if (artifact === undefined) return undefined;
        const record = artifact.record;
        const allowed =
          record.provenance.owner === context.subject &&
          permitsClassification(context.classificationCeiling, record.classification) &&
          context.allowedRegions.includes(record.provenance.region) &&
          context.allowedSources.includes(record.provenance.origin) &&
          context.aclEvidenceRefs.includes(record.provenance.aclEvidenceRef);
        if (!allowed || state.revokedSources.includes(record.provenance.sourceId)) return undefined;
        if (
          state.requests.some(
            (row) => row.subject === record.provenance.owner && row.state !== 'REJECTED',
          )
        )
          return undefined;
        if (Date.parse(record.expiresAt) <= now().getTime()) return undefined;
        return decryptArtifact(keys, record, artifact.envelope);
      });
    },
  };
}
