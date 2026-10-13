import { createMemoryDispatchPort } from './dispatch-port.js';
import { createMemoryLedgerPort, createMemoryLedgerState } from './ledger-port.js';

export function createMemoryTaskPorts(now: () => Date = () => new Date()) {
  const state = createMemoryLedgerState();
  return {
    ledger: createMemoryLedgerPort(now, state),
    dispatch: createMemoryDispatchPort(state, now),
  };
}
