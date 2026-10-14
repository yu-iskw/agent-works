import { isHeld } from './holds.js';
import { governanceHash } from './model.js';
import { purgeArtifact } from './purge.js';

import type { GovernancePort } from '../ports/governance.js';

/** Fence new intake immediately. Held data survives physically but becomes unreadable. */
export async function revokeSource(
  port: GovernancePort,
  sourceId: string,
  actor: string,
  at: Date,
): Promise<{ purged: number; held: number }> {
  if (sourceId.length === 0) throw new Error('source id required');
  return port.transact((state) => {
    if (!state.revokedSources.includes(sourceId)) {
      state.revokedSources.push(sourceId);
      state.audit.push({
        eventId: `revoke:${governanceHash(sourceId)}`,
        type: 'source-revoked',
        occurredAt: at.toISOString(),
        actorHash: governanceHash(actor),
        targetHash: governanceHash(sourceId),
        requestId: null,
        state: null,
        redactionMarker: 'governance-tombstone-v1',
      });
    }
    const report = { purged: 0, held: 0 };
    for (const artifact of [...state.artifacts]) {
      if (artifact.record.provenance.sourceId !== sourceId) continue;
      if (isHeld(state, artifact.record)) {
        report.held += 1;
        continue;
      }
      if (
        purgeArtifact(state, artifact, {
          reason: 'source-revocation',
          requestId: null,
          at: at.toISOString(),
          actor,
        })
      )
        report.purged += 1;
    }
    return report;
  });
}
