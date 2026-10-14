import { validateMemoryState } from '../../memory/state.js';
import { emptyMemoryState } from '../user-memory.js';

import type { MemoryState, MemoryStore } from '../user-memory.js';
/** FIFO transactions, rollback on failure, detached results. */
export function createInMemoryUserMemoryStore(
  initial: MemoryState = emptyMemoryState(),
): MemoryStore {
  let state = structuredClone(initial);
  let pending = Promise.resolve();
  return {
    async transaction<T>(operation: (state: MemoryState) => T): Promise<T> {
      const previous = pending;
      let release!: () => void;
      pending = new Promise<void>((resolve) => {
        release = resolve;
      });
      await previous;
      try {
        const next = structuredClone(state);
        const result = operation(next);
        validateMemoryState(next, state);
        const detached = structuredClone(result);
        state = next;
        return detached;
      } finally {
        release();
      }
    },
  };
}
