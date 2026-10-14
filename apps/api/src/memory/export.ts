import { sameOwner, sameScope } from './evidence.js';
import { recallMemory } from './recall.js';

import type { MemoryPolicy, MemoryStore } from '../ports/user-memory.js';
import type { MemoryScope, MemoryItem } from '@agent-works/domain/user-memory';
/** Owner-visible management spans agents; each recall still uses the exact scope. */
export async function listOwnMemories(
  store: MemoryStore,
  policy: MemoryPolicy,
  scope: MemoryScope,
): Promise<MemoryItem[]> {
  const agents = await store.transaction((state) => [
    ...new Set(state.items.filter((row) => sameOwner(row, scope)).map((row) => row.agent)),
  ]);
  const result: MemoryItem[] = [];
  for (const agent of agents)
    result.push(...(await recallMemory(store, policy, { ...scope, agent })));
  if (!(await policy.tenantEnabled(scope.tenant))) return [];
  return store.transaction((state) =>
    !state.consents.some((row) => sameOwner(row, scope) && row.enabled)
      ? []
      : result.filter(
          (row) =>
            state.items.some(
              (current) =>
                sameScope(current, row) &&
                current.id === row.id &&
                current.revision === row.revision &&
                current.state === 'active' &&
                Date.parse(current.expiresAt) > policy.now().getTime(),
            ) && !state.revokedSources.includes(row.origin.sourceRef ?? ''),
        ),
  );
}
