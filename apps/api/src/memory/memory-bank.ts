import { MemoryDenied } from '../ports/user-memory.js';

import type { MemoryState, MemoryStore } from '../ports/user-memory.js';
/** Typed stub only. #107 owns managed isolation and deletion evidence. */
export function createMemoryBankStub(enabled = false): MemoryStore {
  return {
    transaction<T>(_operation: (state: MemoryState) => T): Promise<T> {
      return Promise.reject(
        enabled ? new Error('operator evidence pending (#107)') : new MemoryDenied(),
      );
    },
  };
}
