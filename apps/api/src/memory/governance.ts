import { governanceHash } from '@agent-works/domain/data-governance';

import { registerDeletionFanout } from '../governance/deletion-requests.js';

import { memoryHash, purgeMemory } from './evidence.js';

import type { GovernancePort, GovernanceState } from '../ports/governance.js';
import type { MemoryState, MemoryStore } from '../ports/user-memory.js';
import type { MemoryItem } from '@agent-works/domain/user-memory';
function heldByGovernance(state: GovernanceState, row: MemoryItem): boolean {
  const current = new Map<string, boolean>();
  for (const hold of state.holds) {
    const target = hold.target;
    const applies =
      target.kind === 'owner'
        ? target.id === row.owner
        : target.kind === 'source'
          ? target.id === row.origin.sourceRef
          : target.id === row.id;
    if (applies) current.set(governanceHash(target), hold.action === 'set');
  }
  return [...current.values()].some(Boolean);
}
function reconcile(state: MemoryState, evidence: GovernanceState, at: Date): void {
  for (const source of evidence.revokedSources)
    if (!state.revokedSources.includes(source)) state.revokedSources.push(source);
  for (const row of [...state.items]) {
    row.legalHold = heldByGovernance(evidence, row);
    const reason = purgeReason(state, evidence, row);
    if (reason === undefined) continue;
    if (row.legalHold) row.state = 'sealed';
    else purgeMemory(state, row, row.id, reason, at.toISOString());
  }
}
function purgeReason(
  state: MemoryState,
  evidence: GovernanceState,
  row: MemoryItem,
): 'deletion-request' | 'revocation' | 'opt-out' | undefined {
  const deleted = evidence.requests.some(
    (request) =>
      request.subject === row.owner &&
      (['HELD', 'SCHEDULED'].includes(request.state) ||
        // Completion covers existing rows, including historical rows restored later.
        (request.state === 'PURGED' && Date.parse(row.createdAt) <= Date.parse(request.updatedAt))),
  );
  const disabled = !state.consents.some(
    (consent) => consent.tenant === row.tenant && consent.owner === row.owner && consent.enabled,
  );
  const revoked = state.revokedSources.includes(row.origin.sourceRef ?? '');
  const tombstoned = state.tombstones.some(
    (tombstone) =>
      tombstone.idHash === memoryHash(row.id) && tombstone.tenantHash === memoryHash(row.tenant),
  );
  if (deleted) return 'deletion-request';
  if (revoked) return 'revocation';
  if (disabled || tombstoned || (row.state === 'sealed' && !row.legalHold)) return 'opt-out';
  return undefined;
}
/** Hold and deletion changes serialize with memory writes under governance's lock.
 * Register exactly once on the governance port used by routes and restore drills. */
export function governUserMemory(
  store: MemoryStore,
  governance: GovernancePort,
  now: () => Date,
): MemoryStore {
  registerDeletionFanout(governance, async (request, state, at) =>
    store.transaction((memory) => {
      reconcile(memory, state, at);
      const rows = memory.items.filter((row) => row.owner === request.subject);
      for (const row of [...rows])
        if (row.legalHold) row.state = 'sealed';
        else purgeMemory(memory, row, row.id, 'deletion-request', at.toISOString());
      return rows.filter((row) => row.legalHold).map((row) => row.id);
    }),
  );
  return {
    async transaction<T>(
      operation: (state: MemoryState, isHeld?: (row: MemoryItem) => boolean) => T,
    ): Promise<T> {
      return governance.transact((evidence) =>
        store.transaction((state) => {
          reconcile(state, evidence, now());
          return operation(state, (row) => heldByGovernance(evidence, row));
        }),
      );
    },
  };
}
