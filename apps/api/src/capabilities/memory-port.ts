import { CapabilityDisabledError, requireCapability } from './gate.js';

import type { CapabilityGuard, GateContext } from './gate.js';

export type MemoryScope = { readonly user: string; readonly agent: string };
type MemoryHint = { readonly id: string; readonly text: string };

/** Optional managed session/memory adapter. Hints are advisory and never carry authority. */
export type SessionMemoryPort = {
  recall(this: void, scope: MemoryScope, limit: number): Promise<readonly MemoryHint[]>;
  remember(this: void, scope: MemoryScope, text: string): Promise<string>;
  forget(this: void, scope: MemoryScope, id: string): Promise<boolean>;
};

export class MemoryUnavailableError extends Error {
  constructor() {
    super('managed memory is unavailable');
    this.name = 'MemoryUnavailableError';
  }
}

/** Default implementation: no managed memory exists. */
export const disabledMemory: SessionMemoryPort = {
  recall: () => Promise.reject(new MemoryUnavailableError()),
  remember: () => Promise.reject(new MemoryUnavailableError()),
  forget: () => Promise.reject(new MemoryUnavailableError()),
};

/** Test double. Isolates by user and agent and deletes for real. Not a managed adapter. */
export function createInMemoryMemory(): SessionMemoryPort {
  const rows = new Map<string, { scope: MemoryScope; text: string }>();
  let next = 0;
  const owns = (scope: MemoryScope, row: { scope: MemoryScope }): boolean =>
    row.scope.user === scope.user && row.scope.agent === scope.agent;
  return {
    recall: (scope, limit) =>
      Promise.resolve(
        [...rows]
          .filter(([, row]) => owns(scope, row))
          .slice(0, limit)
          .map(([id, row]) => ({ id, text: row.text })),
      ),
    remember: (scope, text) => {
      const id = `mem-${String(++next)}`;
      rows.set(id, { scope, text });
      return Promise.resolve(id);
    },
    forget: (scope, id) => {
      const row = rows.get(id);
      if (row === undefined || !owns(scope, row)) return Promise.resolve(false);
      rows.delete(id);
      return Promise.resolve(true);
    },
  };
}

/** Every call asks the guard first; a denial is raised before the adapter is touched. */
export function guardMemory(
  guard: CapabilityGuard,
  context: Omit<GateContext, 'capability'>,
  adapter: SessionMemoryPort,
  now: () => Date,
): SessionMemoryPort {
  const allow = (): void => {
    requireCapability(guard, { ...context, capability: 'managedMemory' }, now());
  };
  return {
    recall: async (scope, limit) => {
      allow();
      return adapter.recall(scope, limit);
    },
    remember: async (scope, text) => {
      allow();
      return adapter.remember(scope, text);
    },
    forget: async (scope, id) => {
      allow();
      return adapter.forget(scope, id);
    },
  };
}

export type RecoveredTask<State> = {
  /** Authoritative state, read only from the system of record. */
  readonly state: State;
  readonly hints: readonly MemoryHint[];
  readonly memory: 'used' | 'disabled' | 'unavailable';
};

/** Core recovery depends on the authoritative store alone. Memory adds hints, and any failure degrades to none. */
export async function recoverTask<State>(input: {
  readonly loadAuthoritative: () => Promise<State>;
  readonly memory: SessionMemoryPort | undefined;
  readonly scope: MemoryScope;
  readonly hintLimit: number;
}): Promise<RecoveredTask<State>> {
  const state = await input.loadAuthoritative();
  if (input.memory === undefined) return { state, hints: [], memory: 'disabled' };
  try {
    const hints = await input.memory.recall(input.scope, input.hintLimit);
    return { state, hints, memory: 'used' };
  } catch (error) {
    const memory = error instanceof CapabilityDisabledError ? 'disabled' : 'unavailable';
    return { state, hints: [], memory };
  }
}
