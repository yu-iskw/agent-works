import { memoryConsentCommandSchema, memoryScopeSchema } from '@agent-works/domain/user-memory';

import { MemoryConflict } from '../ports/user-memory.js';

import { memoryEvidence, purgeMemory, sameOwner } from './evidence.js';

import type { MemoryStore } from '../ports/user-memory.js';
import type { MemoryScope } from '@agent-works/domain/user-memory';
export async function readConsent(store: MemoryStore, scope: MemoryScope, at: Date) {
  memoryScopeSchema.parse(scope);
  return store.transaction(
    (state) =>
      state.consents.find((row) => sameOwner(row, scope)) ?? {
        tenant: scope.tenant,
        owner: scope.owner,
        enabled: false,
        revision: 0,
        noticeVersion: 'memory-v1' as const,
        updatedAt: at.toISOString(),
      },
  );
}
export async function changeConsent(
  store: MemoryStore,
  scope: MemoryScope,
  input: unknown,
  at: Date,
) {
  memoryScopeSchema.parse(scope);
  const command = memoryConsentCommandSchema.parse(input);
  return store.transaction((state) => {
    const index = state.consents.findIndex((row) => sameOwner(row, scope));
    const previous = state.consents.at(index);
    if ((index < 0 ? 0 : previous!.revision) !== command.revision) throw new MemoryConflict();
    const next = {
      tenant: scope.tenant,
      owner: scope.owner,
      enabled: command.enabled,
      revision: command.revision + 1,
      noticeVersion: command.noticeVersion,
      updatedAt: at.toISOString(),
    };
    if (index < 0) state.consents.push(next);
    else state.consents.splice(index, 1, next);
    if (!command.enabled)
      for (const row of [...state.items].filter((item) => sameOwner(item, scope))) {
        if (row.legalHold) {
          row.state = 'sealed';
        } else purgeMemory(state, row, row.id, 'opt-out', at.toISOString());
      }
    memoryEvidence(state, scope, scope.owner, 'consent', {
      at: at.toISOString(),
      revision: next.revision,
    });
    return next;
  });
}
