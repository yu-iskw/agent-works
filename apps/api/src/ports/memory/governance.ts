import { validateGovernanceState } from '../../governance/state.js';
import { emptyGovernanceState } from '../governance.js';

import type { GovernancePort, GovernanceState } from '../governance.js';

/** Copy on commit provides rollback, alias isolation and a FIFO transaction queue. */
export function createMemoryGovernancePort(): GovernancePort {
  let state = emptyGovernanceState();
  let tail: Promise<unknown> = Promise.resolve();
  function transact<T>(operation: (draft: GovernanceState) => T | Promise<T>): Promise<T> {
    const result = tail.then(async () => {
      const draft = structuredClone(state);
      const value = await operation(draft);
      validateGovernanceState(draft, state);
      const committed = structuredClone(draft);
      const detached = structuredClone(value);
      state = committed;
      return detached;
    });
    tail = result.catch(() => undefined);
    return result;
  }
  return {
    transact,
    async snapshot() {
      await tail;
      return structuredClone(state);
    },
  };
}
