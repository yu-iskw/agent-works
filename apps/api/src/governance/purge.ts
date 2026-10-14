import { governanceHash, tombstoneSchema } from '@agent-works/domain/data-governance';

import { isHeld } from './holds.js';

import type { GovernanceState } from '../ports/governance.js';
import type { GovernedArtifact, Tombstone } from '@agent-works/domain/data-governance';

export type PurgeContext = {
  readonly reason: Tombstone['reason'];
  readonly requestId: string | null;
  readonly at: string;
  readonly actor: string;
};
/** Invoked inside the same transaction as eligibility checks. No plaintext enters evidence. */
export function purgeArtifact(
  state: GovernanceState,
  artifact: GovernedArtifact,
  context: PurgeContext,
): boolean {
  if (isHeld(state, artifact.record)) return false;
  const id = artifact.record.id;
  const previous = state.tombstones.find((row) => row.recordId === id);
  state.artifacts = state.artifacts.filter((row) => row.record.id !== id);
  state.derived = state.derived.filter((row) => row.parentId !== id);
  if (previous !== undefined) return true;
  const tombstone = tombstoneSchema.parse({
    recordId: id,
    ownerHash: governanceHash(artifact.record.provenance.owner),
    sourceHash: governanceHash(artifact.record.provenance.sourceId),
    canonicalHash: artifact.record.canonicalHash,
    requestId: context.requestId,
    purgedAt: context.at,
    reason: context.reason,
  });
  state.tombstones.push(tombstone);
  if (state.audit.some((row) => row.type === 'purge' && row.targetHash === governanceHash(id)))
    return true;
  state.audit.push({
    eventId: `purge:${governanceHash(id)}`,
    type: 'purge',
    occurredAt: context.at,
    actorHash: governanceHash(context.actor),
    targetHash: governanceHash(id),
    requestId: context.requestId,
    state: null,
    redactionMarker: 'governance-tombstone-v1',
  });
  return true;
}
