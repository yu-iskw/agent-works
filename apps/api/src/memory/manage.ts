import { memoryEditSchema, memoryDeleteSchema } from '@agent-works/domain/user-memory';
import { minimizeMemoryText } from '@agent-works/domain/user-memory-pii';

import { MemoryConflict, MemoryDenied } from '../ports/user-memory.js';

import { memoryEvidence, purgeMemory, sameScope } from './evidence.js';

import type { MemoryPolicy, MemoryStore } from '../ports/user-memory.js';
import type { MemoryScope } from '@agent-works/domain/user-memory';
export async function reviseMemory(
  store: MemoryStore,
  policy: MemoryPolicy,
  scope: MemoryScope,
  input: unknown,
  at: Date,
) {
  const command = memoryEditSchema.parse(input);
  if (command.agent !== scope.agent || !(await policy.tenantEnabled(scope.tenant)))
    throw new MemoryDenied();
  return store.transaction((state) => {
    const row = state.items.find((item) => sameScope(item, scope) && item.id === command.id);
    if (row === undefined || row.revision !== command.revision || row.state !== 'active')
      throw new MemoryConflict();
    const text = minimizeMemoryText(command.text);
    if (!text) throw new MemoryDenied();
    const next = { ...row, text, revision: row.revision + 1, updatedAt: at.toISOString() };
    state.items.splice(state.items.indexOf(row), 1, next);
    state.history.push(structuredClone(next));
    memoryEvidence(state, scope, row.id, 'revise', {
      at: at.toISOString(),
      revision: next.revision,
    });
    return next;
  });
}
export async function deleteMemory(
  store: MemoryStore,
  scope: MemoryScope,
  input: unknown,
  at: Date,
): Promise<void> {
  const command = memoryDeleteSchema.parse(input);
  if (command.agent !== scope.agent) throw new MemoryDenied();
  await store.transaction((state) => {
    const row = state.items.find((item) => sameScope(item, scope) && item.id === command.id);
    if (row === undefined || row.revision !== command.revision) throw new MemoryConflict();
    if (row.legalHold) throw new MemoryConflict('legal hold');
    purgeMemory(state, scope, row.id, 'delete', at.toISOString());
  });
}
