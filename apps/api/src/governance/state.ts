import {
  expiryFor,
  deletionRequestSchema,
  derivedRowSchema,
  governanceAuditSchema,
  governanceHash,
  governedArtifactSchema,
  legalHoldSchema,
  retentionPolicySchema,
  tombstoneSchema,
} from '@agent-works/domain/data-governance';

import { GovernanceConflict } from '../ports/governance.js';

import { isHeld } from './holds.js';
import { validateRequestIntegrity } from './request-integrity.js';

import type { GovernanceState } from '../ports/governance.js';

function unique<T>(rows: readonly T[], key: (row: T) => string): void {
  const ids = rows.map(key);
  if (new Set(ids).size !== ids.length)
    throw new GovernanceConflict('duplicate governance identity');
}
function preserved<T>(before: readonly T[], after: readonly T[], key: (row: T) => string): void {
  for (const row of before) {
    const next = after.find((item) => key(item) === key(row));
    if (next === undefined || governanceHash(next) !== governanceHash(row))
      throw new GovernanceConflict('governance evidence is append-only');
  }
}
export function validateGovernanceState(state: GovernanceState, previous: GovernanceState): void {
  state.policies = state.policies.map((row) => retentionPolicySchema.parse(row));
  state.artifacts = state.artifacts.map((row) => governedArtifactSchema.parse(row));
  state.derived = state.derived.map((row) => derivedRowSchema.parse(row));
  state.holds = state.holds.map((row) => legalHoldSchema.parse(row));
  state.requests = state.requests.map((row) => deletionRequestSchema.parse(row));
  state.tombstones = state.tombstones.map((row) => tombstoneSchema.parse(row));
  state.audit = state.audit.map((row) => governanceAuditSchema.parse(row));
  unique(state.policies, (row) => row.id);
  unique(state.artifacts, (row) => row.record.id);
  unique(state.derived, (row) => row.id);
  unique(state.holds, (row) => row.commandId);
  unique(state.requests, (row) => row.requestId);
  unique(state.tombstones, (row) => row.recordId);
  unique(state.audit, (row) => row.eventId);
  preserved(previous.policies, state.policies, (row) => row.id);
  preserved(previous.holds, state.holds, (row) => row.commandId);
  preserved(previous.tombstones, state.tombstones, (row) => row.recordId);
  preserved(previous.audit, state.audit, (row) => row.eventId);
  if (previous.revokedSources.some((id) => !state.revokedSources.includes(id)))
    throw new GovernanceConflict('source revocation is immutable');
  const parents = new Set(state.artifacts.map((row) => row.record.id));
  if (state.derived.some((row) => !parents.has(row.parentId)))
    throw new GovernanceConflict('orphan derived row');
  validateRequestIntegrity(state, previous);
  validateArtifacts(state);
  validateRemovedArtifacts(state, previous);
  validateRemovedDerived(state, previous);
}

function validateRemovedDerived(state: GovernanceState, previous: GovernanceState): void {
  for (const row of previous.derived) {
    if (state.derived.some((next) => next.id === row.id && next.parentId === row.parentId))
      continue;
    const parent = previous.artifacts.find((artifact) => artifact.record.id === row.parentId);
    if (parent === undefined) throw new GovernanceConflict('orphan derived row');
    if (isHeld(state, parent.record))
      throw new GovernanceConflict('cannot remove a derived row under an active hold');
    if (!hasPurgeEvidence(state, row.parentId))
      throw new GovernanceConflict('derived row removal requires purge evidence');
  }
}

function hasPurgeEvidence(state: GovernanceState, id: string): boolean {
  return (
    state.tombstones.some((row) => row.recordId === id) ||
    state.audit.some((row) => row.type === 'purge' && row.targetHash === governanceHash(id))
  );
}

function validateRemovedArtifacts(state: GovernanceState, previous: GovernanceState): void {
  const surviving = new Set(state.artifacts.map((row) => row.record.id));
  for (const { record } of previous.artifacts) {
    if (surviving.has(record.id)) continue;
    if (isHeld(state, record))
      throw new GovernanceConflict('cannot remove an artifact under an active hold');
    if (!hasPurgeEvidence(state, record.id))
      throw new GovernanceConflict('artifact removal requires purge evidence');
  }
}

function validateArtifacts(state: GovernanceState): void {
  unique(state.holds, (row) => String(row.sequence));
  if (state.holds.some((row, index) => row.sequence !== index + 1))
    throw new GovernanceConflict('hold sequence must be contiguous');
  if (
    new Set(state.revokedSources).size !== state.revokedSources.length ||
    state.revokedSources.some((id) => id.length === 0 || id.length > 512)
  ) {
    throw new GovernanceConflict('invalid source revocation identity');
  }
  for (const artifact of state.artifacts) {
    const record = artifact.record;
    const policy = state.policies.find((row) => row.id === record.retentionClass);
    if (policy === undefined || expiryFor(record.createdAt, policy) !== record.expiresAt)
      throw new GovernanceConflict('retention mismatch');
    if (record.legalHold !== isHeld(state, record))
      throw new GovernanceConflict('hold summary mismatch');
    if (state.tombstones.some((row) => row.recordId === record.id))
      throw new GovernanceConflict('tombstoned artifact');
  }
}
