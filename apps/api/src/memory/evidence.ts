import { createHash, randomUUID } from 'node:crypto';

import type { MemoryState } from '../ports/user-memory.js';
import type { MemoryScope } from '@agent-works/domain/user-memory';
export function memoryHash(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}
export function sameOwner(
  a: { tenant: string; owner: string },
  b: { tenant: string; owner: string },
): boolean {
  return a.tenant === b.tenant && a.owner === b.owner;
}
export function sameScope(a: MemoryScope, b: MemoryScope): boolean {
  return sameOwner(a, b) && a.agent === b.agent;
}
export function memoryEvidence(
  state: MemoryState,
  scope: MemoryScope,
  id: string,
  action: MemoryState['audit'][number]['action'],
  event: { at: string; revision?: number },
): void {
  state.audit.push({
    id: randomUUID(),
    at: event.at,
    tenantHash: memoryHash(scope.tenant),
    ownerHash: memoryHash(scope.owner),
    targetHash: memoryHash(id),
    action,
    revision: event.revision ?? 0,
  });
}
export function purgeMemory(
  state: MemoryState,
  scope: MemoryScope,
  id: string,
  reason: MemoryState['audit'][number]['action'],
  at: string,
): void {
  state.items = state.items.filter((row) => !(sameScope(row, scope) && row.id === id));
  state.history = state.history.filter((row) => !(sameScope(row, scope) && row.id === id));
  const idHash = memoryHash(id);
  if (
    !state.tombstones.some(
      (row) => row.idHash === idHash && row.tenantHash === memoryHash(scope.tenant),
    )
  )
    state.tombstones.push({
      tenantHash: memoryHash(scope.tenant),
      ownerHash: memoryHash(scope.owner),
      idHash,
      at,
      reason,
    });
  memoryEvidence(state, scope, id, reason, { at });
}
