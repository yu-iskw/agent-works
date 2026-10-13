import { expect, it } from 'vitest';

import { acceptInput, dispatchPortContract } from '../dispatch-port.contract.js';
import { proofOf } from '../dispatch-port.js';

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

it('keeps the stored payload unchanged when a claimed payload is mutated', async () => {
  const { dispatch } = createMemoryDispatchHarness().open();
  await dispatch.accept(acceptInput);
  const claimed = await dispatch.claim('worker-a', 60_000);
  if (claimed === undefined) throw new Error('missing claim');
  const original = structuredClone(claimed.payload);
  claimed.payload.subject = 'mallory';
  claimed.payload.policy.policyVersion = 'changed';
  if (claimed.payload.request.input === undefined) throw new Error('missing input');
  claimed.payload.request.input.incidentId = 'changed';

  await dispatch.release(proofOf(claimed));
  const reclaimed = await dispatch.claim('worker-b', 60_000);
  expect(reclaimed?.payload).toEqual(original);
});
