import {
  memoryItemSchema,
  memoryProposalSchema,
  memoryScopeSchema,
} from '@agent-works/domain/user-memory';
import { minimizeMemoryText } from '@agent-works/domain/user-memory-pii';

import { MemoryConflict, MemoryDenied } from '../ports/user-memory.js';

import { memoryEvidence, memoryHash, sameOwner } from './evidence.js';

import type { MemoryPolicy, MemoryStore } from '../ports/user-memory.js';
import type { MemoryScope } from '@agent-works/domain/user-memory';
/** Scope and turn subject come from trusted authentication, never retrieved text. */
export async function proposeMemory(
  store: MemoryStore,
  policy: MemoryPolicy,
  scope: MemoryScope,
  input: unknown,
) {
  memoryScopeSchema.parse(scope);
  const proposal = memoryProposalSchema.parse(input);
  if (
    proposal.origin.subject !== scope.owner ||
    proposal.classification === 'RESTRICTED' ||
    !(await policy.tenantEnabled(scope.tenant))
  )
    throw new MemoryDenied();
  if (
    proposal.origin.sourceRef !== null &&
    !(await policy.sourceAllowed(scope, proposal.origin.sourceRef))
  )
    throw new MemoryDenied();
  if (!(await policy.tenantEnabled(scope.tenant))) throw new MemoryDenied();
  const at = policy.now();
  const text = minimizeMemoryText(proposal.text);
  if (!text) throw new MemoryDenied();
  return store.transaction((state) => {
    if (!state.consents.some((row) => sameOwner(row, scope) && row.enabled))
      throw new MemoryDenied();
    if (
      state.revokedSources.includes(proposal.origin.sourceRef ?? '') ||
      state.tombstones.some((row) => row.idHash === memoryHash(proposal.id))
    )
      throw new MemoryDenied();
    if (state.items.some((row) => row.id === proposal.id)) throw new MemoryConflict();
    const item = memoryItemSchema.parse({
      ...proposal,
      ...scope,
      text,
      revision: 1,
      createdAt: at.toISOString(),
      updatedAt: at.toISOString(),
      expiresAt: new Date(at.getTime() + proposal.ttlSeconds * 1000).toISOString(),
      legalHold: false,
      state: 'active',
    });
    state.items.push(item);
    state.history.push(structuredClone(item));
    memoryEvidence(state, scope, item.id, 'propose', { at: at.toISOString(), revision: 1 });
    return item;
  });
}
