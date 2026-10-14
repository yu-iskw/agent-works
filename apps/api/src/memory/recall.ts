import { memoryScopeSchema } from '@agent-works/domain/user-memory';

import { sameOwner, sameScope } from './evidence.js';

import type { MemoryPolicy, MemoryStore } from '../ports/user-memory.js';
import type { MemoryItem, MemoryScope } from '@agent-works/domain/user-memory';
/** Fail closed if live source authorization cannot be checked. */
export async function recallMemory(store: MemoryStore, policy: MemoryPolicy, scope: MemoryScope) {
  memoryScopeSchema.parse(scope);
  if (!(await policy.tenantEnabled(scope.tenant))) return [];
  const at = policy.now().getTime();
  const rows = await store.transaction((state) =>
    !state.consents.some((row) => sameOwner(row, scope) && row.enabled)
      ? []
      : state.items.filter(
          (row) =>
            sameScope(row, scope) &&
            row.state === 'active' &&
            Date.parse(row.expiresAt) > at &&
            !state.revokedSources.includes(row.origin.sourceRef ?? ''),
        ),
  );
  const allowed: MemoryItem[] = [];
  for (const row of rows) {
    try {
      if (
        row.origin.sourceRef === null ||
        (await policy.sourceAllowed(scope, row.origin.sourceRef))
      )
        allowed.push(row);
    } catch {
      /* source service unavailable: omit */
    }
  }
  if (!(await policy.tenantEnabled(scope.tenant))) return [];
  // Recheck consent/revisions after asynchronous ACL calls to avoid revocation races.
  return store.transaction((state) =>
    !state.consents.some((row) => sameOwner(row, scope) && row.enabled)
      ? []
      : allowed.filter(
          (row) =>
            state.items.some(
              (current) =>
                sameScope(current, scope) &&
                current.id === row.id &&
                current.revision === row.revision &&
                current.state === 'active' &&
                Date.parse(current.expiresAt) > policy.now().getTime(),
            ) && !state.revokedSources.includes(row.origin.sourceRef ?? ''),
        ),
  );
}
