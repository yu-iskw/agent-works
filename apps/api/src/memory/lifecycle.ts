import { MemoryConflict } from '../ports/user-memory.js';

import { memoryEvidence, purgeMemory, sameOwner } from './evidence.js';

import type { MemoryStore } from '../ports/user-memory.js';
import type { MemoryScope } from '@agent-works/domain/user-memory';
export async function sweepMemory(store: MemoryStore, at: Date): Promise<number> {
  return store.transaction((state) => {
    let purged = 0;
    for (const row of [...state.items])
      if (Date.parse(row.expiresAt) <= at.getTime() && !row.legalHold) {
        purgeMemory(state, row, row.id, 'expiry', at.toISOString());
        purged++;
      }
    return purged;
  });
}
export async function holdMemory(
  store: MemoryStore,
  scope: MemoryScope,
  id: string,
  held: boolean,
  at: Date,
): Promise<void> {
  await store.transaction((state) => {
    const row = state.items.find(
      (item) => sameOwner(item, scope) && item.agent === scope.agent && item.id === id,
    );
    if (!row) throw new MemoryConflict();
    row.legalHold = held;
    memoryEvidence(state, scope, id, held ? 'hold' : 'release', {
      at: at.toISOString(),
      revision: row.revision,
    });
    if (!held && row.state === 'sealed') purgeMemory(state, row, id, 'opt-out', at.toISOString());
  });
}
export async function deleteOwnerMemories(
  store: MemoryStore,
  scope: MemoryScope,
  at: Date,
): Promise<{ held: string[] }> {
  return store.transaction((state) => {
    const rows = state.items.filter((row) => sameOwner(row, scope));
    const held = rows.filter((row) => row.legalHold).map((row) => row.id);
    for (const row of rows)
      if (row.legalHold) row.state = 'sealed';
      else purgeMemory(state, row, row.id, 'deletion-request', at.toISOString());
    return { held };
  });
}
export async function revokeMemorySource(
  store: MemoryStore,
  sourceRef: string,
  at: Date,
): Promise<void> {
  await store.transaction((state) => {
    if (!state.revokedSources.includes(sourceRef)) state.revokedSources.push(sourceRef);
    for (const row of [...state.items])
      if (row.origin.sourceRef === sourceRef) {
        if (row.legalHold) row.state = 'sealed';
        else purgeMemory(state, row, row.id, 'revocation', at.toISOString());
      }
  });
}
