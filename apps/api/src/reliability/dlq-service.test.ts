import { describe, expect, it } from 'vitest';

import { createMemoryDispatchHarness } from '../ports/memory/dispatch-port.js';

import { createDlqService } from './dlq-service.js';
import { fixtureInstant, fixtureRequest } from './fixtures.js';
import { createMemoryDlqStore } from './memory-dlq.js';

const review = {
  decisionId: 'review-1',
  operator: 'fixture-operator',
  reason: 'Inspected receipt and task state',
  occurredAt: fixtureInstant,
};
async function setup(riskyWrite = false) {
  const harness = createMemoryDispatchHarness();
  harness.setNow(fixtureInstant);
  const { dispatch, ledger } = harness.open();
  const accepted = await dispatch.accept(fixtureRequest);
  const lease = await dispatch.claim('fixture-reviewer', 60_000);
  if (lease === undefined) throw new Error('fixture lease');
  const store = createMemoryDlqStore();
  const service = createDlqService(store, dispatch, ledger);
  const entry = await service.stuck({
    entryId: 'dlq-1',
    taskId: accepted.taskId,
    subject: fixtureRequest.subject,
    idempotencyKey: fixtureRequest.idempotencyKey,
    riskyWrite,
    reason: 'stuck',
    createdAt: fixtureInstant,
  });
  return { harness, service, store, accepted, dispatch, ledger, lease, entry };
}
describe('explicit dead-letter review', () => {
  it('lists a stuck task and requeues the original idempotency key', async () => {
    const test = await setup();
    expect(await test.service.list()).toEqual([test.entry]);
    const result = await test.service.requeue(
      test.entry.entryId,
      review,
      test.lease,
      fixtureInstant,
      1,
    );
    expect(result).toMatchObject({
      idempotencyKey: fixtureRequest.idempotencyKey,
      state: 'requeued',
    });
    expect((await test.dispatch.accept(fixtureRequest)).taskId).toBe(test.accepted.taskId);
    expect(await test.harness.counts()).toEqual({ tasks: 1, outbox: 1, deliveries: 1 });
    expect(await test.store.decisions()).toHaveLength(2);
  });
  it('requires explicit compensation evidence for risky writes', async () => {
    const test = await setup(true);
    await expect(
      test.service.requeue(test.entry.entryId, review, test.lease, fixtureInstant, 1),
    ).rejects.toMatchObject({ code: 'risky_write_requires_compensation' });
    await expect(test.service.compensate(test.entry.entryId, review, '')).rejects.toMatchObject({
      code: 'evidence',
    });
    expect(
      await test.service.compensate(test.entry.entryId, review, 'independent-compensation-receipt'),
    ).toMatchObject({ state: 'compensated' });
    expect(await test.store.decisions()).toEqual([
      expect.objectContaining({
        action: 'compensate',
        evidenceRef: 'independent-compensation-receipt',
      }),
    ]);
  });
  it('leaves a durable pending intent on stale lease failure', async () => {
    const test = await setup();
    test.harness.setNow(test.lease.leaseUntil);
    await expect(
      test.service.requeue(test.entry.entryId, review, test.lease, fixtureInstant, 1),
    ).rejects.toThrow();
    expect(await test.store.read(test.entry.entryId)).toMatchObject({ state: 'requeue_pending' });
    expect(await test.store.decisions()).toHaveLength(1);
  });
  it('rejects an unrelated lease and records no scheduling decision', async () => {
    const test = await setup();
    await expect(
      test.service.requeue(
        test.entry.entryId,
        review,
        { ...test.lease, taskId: 'other' },
        fixtureInstant,
        1,
      ),
    ).rejects.toMatchObject({ code: 'lease' });
    expect(await test.store.decisions()).toEqual([]);
  });
  it('rejects incomplete review evidence and stale decision versions', async () => {
    const test = await setup();
    await expect(
      test.service.compensate(test.entry.entryId, { ...review, operator: '' }, 'receipt'),
    ).rejects.toMatchObject({ code: 'evidence' });
    await test.service.compensate(test.entry.entryId, review, 'receipt');
    await expect(
      test.service.compensate(test.entry.entryId, { ...review, decisionId: 'other' }, 'receipt'),
    ).rejects.toMatchObject({ code: 'closed' });
  });
});
