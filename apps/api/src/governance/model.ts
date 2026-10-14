/** The issue's exclusive paths prohibit changing the domain package export map.
 * Import the workspace's compiled domain contract; pnpm build builds domain first.
 * src and dist have the same directory depth, so the URL survives compilation. */
export {
  canTransitionDeletion,
  deletionCommandSchema,
  deletionRequestSchema,
  derivedRowSchema,
  encryptedEnvelopeSchema,
  expiryFor,
  governanceAuditSchema,
  governanceClassificationSchema,
  governanceHash,
  governedArtifactSchema,
  governedRecordSchema,
  holdCommandSchema,
  legalHoldSchema,
  permitsClassification,
  retentionPolicySchema,
  sourceData,
  sourceDataSchema,
  tombstoneSchema,
} from '../../../../packages/domain/dist/data-governance.js';
export type {
  DeletionCommand,
  DeletionRequest,
  DeletionState,
  DerivedRow,
  EncryptedEnvelope,
  GovernanceAudit,
  GovernanceClassification,
  GovernedArtifact,
  GovernedRecord,
  HoldCommand,
  LegalHold,
  RetentionPolicy,
  Tombstone,
} from '../../../../packages/domain/dist/data-governance.js';
