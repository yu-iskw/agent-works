import {
  memoryAuditSchema,
  memoryConsentSchema,
  memoryItemSchema,
  memoryTombstoneSchema,
} from '@agent-works/domain/user-memory';

import { MemoryConflict } from '../ports/user-memory.js';

import { memoryHash, sameOwner, sameScope } from './evidence.js';

import type { MemoryState } from '../ports/user-memory.js';
function unique(keys: string[]): void {
  if (new Set(keys).size !== keys.length) throw new MemoryConflict('duplicate memory state key');
}
function ownerKey(row: { tenant: string; owner: string }): string {
  return JSON.stringify([row.tenant, row.owner]);
}
/** Defense against adapter/import corruption. Erasure may remove history, never rewrite it. */
export function validateMemoryState(state: MemoryState, before: MemoryState): void {
  state.consents.forEach((row) => memoryConsentSchema.parse(row));
  state.items.forEach((row) => memoryItemSchema.parse(row));
  state.history.forEach((row) => memoryItemSchema.parse(row));
  state.audit.forEach((row) => memoryAuditSchema.parse(row));
  state.tombstones.forEach((row) => memoryTombstoneSchema.parse(row));
  unique(state.consents.map(ownerKey));
  unique(state.items.map((row) => row.id));
  unique(state.history.map((row) => `${row.id}:${row.revision}`));
  unique(state.audit.map((row) => row.id));
  validateEvidence(state, before);
  validateHistory(state, before);
  for (const row of state.items) validateCurrentItem(row, state, before);
}
function validateEvidence(state: MemoryState, before: MemoryState): void {
  for (const previous of before.audit)
    if (
      !state.audit.some(
        (row) => row.id === previous.id && JSON.stringify(row) === JSON.stringify(previous),
      )
    )
      throw new MemoryConflict('audit immutable');
  for (const previous of before.tombstones)
    if (!state.tombstones.some((row) => JSON.stringify(row) === JSON.stringify(previous)))
      throw new MemoryConflict('tombstone immutable');
  for (const source of before.revokedSources)
    if (!state.revokedSources.includes(source))
      throw new MemoryConflict('source revocation immutable');
}
function validateCurrentItem(
  row: MemoryState['items'][number],
  state: MemoryState,
  before: MemoryState,
): void {
  if (row.origin.subject !== row.owner) throw new MemoryConflict('origin owner mismatch');
  if (Date.parse(row.expiresAt) <= Date.parse(row.createdAt))
    throw new MemoryConflict('invalid memory TTL');
  if (
    !state.history.some(
      (item) =>
        sameScope(item, row) &&
        item.id === row.id &&
        item.revision === row.revision &&
        item.text === row.text,
    )
  )
    throw new MemoryConflict('current revision history missing');
  const previous = before.items.find((item) => item.id === row.id);
  if (
    previous &&
    (!sameScope(previous, row) ||
      JSON.stringify(previous.origin) !== JSON.stringify(row.origin) ||
      previous.expiresAt !== row.expiresAt ||
      row.revision < previous.revision)
  )
    throw new MemoryConflict('memory authority changed');
}
function validateHistory(state: MemoryState, before: MemoryState): void {
  for (const row of state.history) {
    const item = state.items.find((item) => item.id === row.id && sameOwner(item, row));
    if (!item || !sameScope(item, row)) throw new MemoryConflict('orphan memory revision');
    const previous = before.history.find(
      (item) => item.id === row.id && item.revision === row.revision,
    );
    if (previous && JSON.stringify(previous) !== JSON.stringify(row))
      throw new MemoryConflict('history append-only');
  }
  for (const row of before.history)
    if (!state.history.some((item) => item.id === row.id && item.revision === row.revision)) {
      const purged = state.tombstones.some(
        (item) => item.idHash === memoryHash(row.id) && item.tenantHash === memoryHash(row.tenant),
      );
      if (state.items.some((item) => item.id === row.id) || !purged)
        throw new MemoryConflict('history erasure requires purge evidence');
    }
}
