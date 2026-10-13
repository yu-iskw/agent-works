import { expect, it } from 'vitest';

import { acceptInput, dispatchPortContract } from '../dispatch-port.contract.js';

import { createMemoryDispatchHarness, createMemoryDispatchPort } from './dispatch-port.js';
import { createMemoryLedgerState } from './ledger-port.js';

const startedAt = '2026-10-10T10:00:00.000Z';

dispatchPortContract(() => createMemoryDispatchHarness());

it('accepts through a port created without a fault seam', async () => {
  const now = () => new Date(startedAt);
  const accepted = await createMemoryDispatchPort(createMemoryLedgerState(), now).accept(
    acceptInput,
  );
  expect(accepted).toMatchObject({ status: 'QUEUED', submittedAt: startedAt });
});
