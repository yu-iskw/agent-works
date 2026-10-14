import { governanceHash } from '@agent-works/domain/data-governance';

import { emptyGovernanceState, GovernanceConflict } from '../ports/governance.js';

import { isHeld } from './holds.js';
import { purgeArtifact } from './purge.js';
import { validateGovernanceState } from './state.js';

import type { GovernancePort, GovernanceState } from '../ports/governance.js';

function mergeEvidence<T>(target: T[], incoming: readonly T[], key: (row: T) => string): void {
  for (const row of incoming) {
    const existing = target.find((item) => key(item) === key(row));
    if (existing === undefined) target.push(structuredClone(row));
    else if (governanceHash(existing) !== governanceHash(row))
      throw new GovernanceConflict('restore evidence conflict');
  }
}

function restoreEvidence(state: GovernanceState, evidence: GovernanceState): void {
  // A current evidence export must include every previously known hold command.
  // Replacing a stale prefix is valid; deleting an existing command is not.
  state.holds = structuredClone(evidence.holds);
  state.requests = structuredClone(evidence.requests);
  state.revokedSources = [...new Set([...state.revokedSources, ...evidence.revokedSources])];
  mergeEvidence(state.tombstones, evidence.tombstones, (row) => row.recordId);
  mergeEvidence(state.audit, evidence.audit, (row) => row.eventId);
  for (const artifact of state.artifacts)
    artifact.record.legalHold = isHeld(state, artifact.record);
}

function repurgeRestoredRows(
  state: GovernanceState,
  evidence: GovernanceState,
  at: Date,
): string[] {
  const ids = new Set(evidence.tombstones.map((row) => row.recordId));
  const deletedOwners = new Set(
    evidence.requests.filter((row) => row.state === 'PURGED').map((row) => row.subject),
  );
  const repurged: string[] = [];
  for (const artifact of [...state.artifacts]) {
    const record = artifact.record;
    const deleted = ids.has(record.id) || deletedOwners.has(record.provenance.owner);
    const revoked = state.revokedSources.includes(record.provenance.sourceId);
    if (!deleted && !revoked) continue;
    // Conflicting current evidence needs operator reconciliation while offline.
    if (isHeld(state, record)) {
      if (deleted) throw new GovernanceConflict('restore deletion conflicts with legal hold');
      continue;
    }
    const request = evidence.requests.find(
      (row) => row.state === 'PURGED' && row.subject === record.provenance.owner,
    );
    purgeArtifact(state, artifact, {
      reason: deleted ? 'deletion' : 'source-revocation',
      requestId: request?.requestId ?? null,
      at: at.toISOString(),
      actor: 'system:restore',
    });
    repurged.push(record.id);
  }
  state.derived = state.derived.filter((row) => !ids.has(row.parentId));
  return repurged;
}

/** Evidence must come from the trusted live store outside the restored backup.
 * The caller keeps traffic disabled until this transaction commits. No managed
 * backup deletion guarantee is implied by an offline replay. */
export async function reapplyAfterRestore(
  port: GovernancePort,
  input: GovernanceState,
  drillId: string,
  at: Date,
): Promise<{ repurged: string[] }> {
  if (drillId.length === 0 || drillId.length > 512)
    throw new GovernanceConflict('drill id required');
  const evidence = structuredClone(input);
  validateGovernanceState(evidence, emptyGovernanceState());
  return port.transact((state) => {
    restoreEvidence(state, evidence);
    const repurged = repurgeRestoredRows(state, evidence, at);
    for (const id of repurged) {
      const eventId = `restore:${governanceHash({ drillId, id })}`;
      if (!state.audit.some((row) => row.eventId === eventId))
        state.audit.push({
          eventId,
          type: 'restore-repurge',
          occurredAt: at.toISOString(),
          actorHash: governanceHash('system:restore'),
          targetHash: governanceHash(id),
          requestId: null,
          state: null,
          redactionMarker: 'governance-tombstone-v1',
        });
    }
    return { repurged };
  });
}
