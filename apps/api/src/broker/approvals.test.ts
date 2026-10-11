import { expect, it } from 'vitest';

import { createApprovalHarness, useApprovalDatabase } from './broker-harness.js';

const database = useApprovalDatabase();

it('rejects a second approval for the same task, step, and payload', async () => {
  const harness = await createApprovalHarness(database.sql());
  try {
    await harness.save(harness.row());
    await expect(harness.save(harness.row({ id: 'apr-2' }))).rejects.toThrow();
  } finally {
    await harness.stop();
  }
});

it('replay returns the same receipt and one ticket', async () => {
  const harness = await createApprovalHarness(database.sql());
  try {
    await harness.save(harness.row());
    const first = await harness.execute();
    const second = await harness.execute();
    expect(first).toEqual({ ok: true, receipt: 'FAKE-1', replay: false });
    expect(second).toEqual({ ok: true, receipt: 'FAKE-1', replay: true });
    expect(harness.posts()).toBe(1);
    expect(await harness.tickets()).toBe(1);
    expect(harness.intentBeforePost()).toBe(true);
    expect(await harness.read('apr-1')).toMatchObject({ executionsUsed: 1, state: 'approved' });
  } finally {
    await harness.stop();
  }
});

it('payload mutation fails closed', async () => {
  const harness = await createApprovalHarness(database.sql());
  try {
    await harness.save(harness.row());
    const result = await harness.execute({
      payload: { summary: 'Changed summary', project: 'PROJ' },
    });
    expect(result).toEqual({ ok: false, status: 422, code: 'APPROVAL_REQUIRED' });
    expect(harness.posts()).toBe(0);
    expect(await harness.tickets()).toBe(0);
    expect(await harness.read('apr-1')).toMatchObject({ executionsUsed: 0 });
  } finally {
    await harness.stop();
  }
});

it('target swap fails closed', async () => {
  const harness = await createApprovalHarness(database.sql());
  try {
    await harness.save(harness.row());
    const result = await harness.execute({ targetResource: 'OTHER' });
    expect(result).toEqual({ ok: false, status: 422, code: 'APPROVAL_REQUIRED' });
    expect(harness.posts()).toBe(0);
    expect(await harness.tickets()).toBe(0);
  } finally {
    await harness.stop();
  }
});

it('task swap fails closed', async () => {
  const harness = await createApprovalHarness(database.sql());
  try {
    await harness.save(harness.row());
    const result = await harness.execute({ taskId: 'tsk-2' });
    expect(result).toEqual({ ok: false, status: 422, code: 'APPROVAL_REQUIRED' });
    expect(harness.posts()).toBe(0);
    expect(await harness.tickets()).toBe(0);
    expect(await harness.read('apr-1')).toMatchObject({ executionsUsed: 0 });
  } finally {
    await harness.stop();
  }
});

it('step swap fails closed', async () => {
  const harness = await createApprovalHarness(database.sql());
  try {
    await harness.save(harness.row());
    const result = await harness.execute({ stepId: 'step-2' });
    expect(result).toEqual({ ok: false, status: 422, code: 'APPROVAL_REQUIRED' });
    expect(harness.posts()).toBe(0);
    expect(await harness.tickets()).toBe(0);
    expect(await harness.read('apr-1')).toMatchObject({ executionsUsed: 0 });
  } finally {
    await harness.stop();
  }
});

it('tool swap fails closed', async () => {
  const harness = await createApprovalHarness(database.sql());
  try {
    await harness.save(harness.row());
    const result = await harness.execute({ toolRef: 'ticket.delete@1.0.0' });
    expect(result).toEqual({ ok: false, status: 422, code: 'APPROVAL_REQUIRED' });
    expect(harness.posts()).toBe(0);
    expect(await harness.tickets()).toBe(0);
  } finally {
    await harness.stop();
  }
});

it('expired approval fails closed', async () => {
  const harness = await createApprovalHarness(database.sql());
  try {
    await harness.save(harness.row({ expiresAt: '2026-10-01T00:00:00.000Z' }));
    const result = await harness.execute();
    expect(result).toEqual({ ok: false, status: 422, code: 'APPROVAL_EXPIRED' });
    expect(harness.posts()).toBe(0);
    expect(await harness.tickets()).toBe(0);
  } finally {
    await harness.stop();
  }
});

it('approver removed fails closed', async () => {
  const harness = await createApprovalHarness(database.sql(), () => false);
  try {
    await harness.save(harness.row());
    const result = await harness.execute();
    expect(result).toEqual({ ok: false, status: 422, code: 'APPROVAL_REQUIRED' });
    expect(harness.posts()).toBe(0);
    expect(await harness.read('apr-1')).toMatchObject({ executionsUsed: 0 });
  } finally {
    await harness.stop();
  }
});

it('removed approver cannot bind', async () => {
  const harness = await createApprovalHarness(database.sql(), (sub) => sub === 'bob');
  try {
    await harness.save(harness.row({ state: 'pending', approverSub: null }));
    const removed = await harness.broker.bindApproval('apr-1', {
      actorSub: 'mallory',
      decision: 'approve',
      expectedPayloadSha256: harness.digest,
    });
    expect(removed).toEqual({ ok: false, status: 422, code: 'APPROVAL_REQUIRED' });
    const rejected = await harness.broker.bindApproval('apr-1', {
      actorSub: 'mallory',
      decision: 'reject',
      expectedPayloadSha256: harness.digest,
    });
    expect(rejected).toEqual({ ok: false, status: 422, code: 'APPROVAL_REQUIRED' });
    expect(await harness.read('apr-1')).toMatchObject({ state: 'pending', approverSub: null });
    const bound = await harness.broker.bindApproval('apr-1', {
      actorSub: 'bob',
      decision: 'approve',
      expectedPayloadSha256: harness.digest,
    });
    expect(bound.ok).toBe(true);
    expect(await harness.read('apr-1')).toMatchObject({ state: 'approved', approverSub: 'bob' });
  } finally {
    await harness.stop();
  }
});

it('self-approval fails closed', async () => {
  const harness = await createApprovalHarness(database.sql());
  try {
    await harness.save(harness.row({ state: 'pending', approverSub: null }));
    const bound = await harness.broker.bindApproval('apr-1', {
      actorSub: 'alice',
      decision: 'approve',
      expectedPayloadSha256: harness.digest,
    });
    expect(bound).toEqual({ ok: false, status: 422, code: 'APPROVAL_REQUIRED' });
    expect(await harness.read('apr-1')).toMatchObject({ state: 'pending', approverSub: null });
    const executed = await harness.execute();
    expect(executed).toEqual({ ok: false, status: 422, code: 'APPROVAL_REQUIRED' });
    expect(harness.posts()).toBe(0);
  } finally {
    await harness.stop();
  }
});

it('policy-down does not call the tool', async () => {
  const harness = await createApprovalHarness(database.sql());
  try {
    await harness.save(harness.row());
    const result = await harness.execute({ facts: {} });
    expect(result).toEqual({ ok: false, status: 422, code: 'POLICY_DENIED' });
    expect(harness.posts()).toBe(0);
    expect(await harness.tickets()).toBe(0);
    expect(await harness.read('apr-1')).toMatchObject({ executionsUsed: 0 });
  } finally {
    await harness.stop();
  }
});
