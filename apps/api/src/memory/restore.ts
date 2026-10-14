import { MemoryConflict } from '../ports/user-memory.js';

import { memoryHash, purgeMemory, sameOwner } from './evidence.js';

import type { MemoryState, MemoryStore } from '../ports/user-memory.js';
/** Restore evidence comes from the live store; keep traffic closed until complete. */
export async function restoreUserMemory(
  store: MemoryStore,
  evidence: MemoryState,
  at: Date,
): Promise<number> {
  return store.transaction((state, isHeld) => {
    // Governance holds and releases under this transaction's lock override snapshots.
    const resolveHold =
      isHeld ??
      ((row: MemoryState['items'][number]) =>
        evidence.items.find((item) => item.id === row.id && sameOwner(item, row))?.legalHold ??
        false);
    mergeAudit(state, evidence);
    state.consents = structuredClone(evidence.consents);
    state.revokedSources = [...new Set([...state.revokedSources, ...evidence.revokedSources])];
    mergeTombstones(state, evidence);
    let purged = 0;
    for (const row of [...state.items]) {
      const live = evidence.items.find((item) => item.id === row.id && sameOwner(item, row));
      row.legalHold = resolveHold(row);
      if (live?.state === 'sealed') row.state = 'sealed';
      const deleted = state.tombstones.some(
        (item) => item.idHash === memoryHash(row.id) && item.tenantHash === memoryHash(row.tenant),
      );
      const disabled = !state.consents.some((item) => sameOwner(item, row) && item.enabled);
      const revoked = state.revokedSources.includes(row.origin.sourceRef ?? '');
      if (
        !deleted &&
        !disabled &&
        !revoked &&
        row.state !== 'sealed' &&
        Date.parse(row.expiresAt) > at.getTime()
      )
        continue;
      if (row.legalHold) {
        if (deleted) throw new MemoryConflict('restore deletion conflicts with hold');
        row.state = 'sealed';
        continue;
      }
      purgeMemory(state, row, row.id, 'restore', at.toISOString());
      purged++;
    }
    return purged;
  });
}

function mergeAudit(state: MemoryState, evidence: MemoryState): void {
  for (const incoming of evidence.audit) {
    const existing = state.audit.find((row) => row.id === incoming.id);
    if (existing === undefined) state.audit.push(structuredClone(incoming));
    else if (JSON.stringify(existing) !== JSON.stringify(incoming))
      throw new MemoryConflict('restore audit evidence conflict');
  }
}

function mergeTombstones(state: MemoryState, evidence: MemoryState): void {
  for (const tombstone of evidence.tombstones)
    if (
      !state.tombstones.some(
        (row) => row.idHash === tombstone.idHash && row.tenantHash === tombstone.tenantHash,
      )
    )
      state.tombstones.push(structuredClone(tombstone));
}
