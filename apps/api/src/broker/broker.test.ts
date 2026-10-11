import { expect, it } from 'vitest';

import { createApprovalHarness, useApprovalDatabase } from './broker-harness.js';

const database = useApprovalDatabase();

it('duplicate-call-id-rejected', async () => {
  const harness = await createApprovalHarness(database.sql());
  try {
    await harness.save(harness.row());
    const first = await harness.execute();
    const second = await harness.execute({ idempotencyKey: 'key-2' });
    expect(first).toEqual({ ok: true, receipt: 'FAKE-1', replay: false });
    expect(second).toEqual({ ok: false, status: 409, code: 'DUPLICATE_CALL' });
    expect(harness.posts()).toBe(1);
    expect(await harness.tickets()).toBe(1);
  } finally {
    await harness.stop();
  }
});

it('resumes an intended call after the ticket post fails', async () => {
  const harness = await createApprovalHarness(database.sql());
  try {
    await harness.save(harness.row());
    harness.failNextPost();
    await expect(harness.execute()).rejects.toThrow('ticket transport');
    const resumed = await harness.execute({ traceId: 'trace-2', actorSub: 'carol' });
    expect(resumed).toEqual({ ok: true, receipt: 'FAKE-1', replay: false });
    expect(harness.posts()).toBe(1);
    expect(await harness.tickets()).toBe(1);
    const replay = await harness.execute();
    expect(replay).toEqual({ ok: true, receipt: 'FAKE-1', replay: true });
    const swapped = await harness.execute({ approvalId: 'apr-2' });
    expect(swapped).toEqual({ ok: false, status: 422, code: 'APPROVAL_REQUIRED' });
    expect(harness.posts()).toBe(1);
    expect(await harness.tickets()).toBe(1);
    expect(harness.posts()).toBe(1);
    expect(await harness.tickets()).toBe(1);
  } finally {
    await harness.stop();
  }
});

it('non-string-key-payload-rejected', async () => {
  const harness = await createApprovalHarness(database.sql());
  try {
    await harness.save(harness.row());
    const payload: Record<string, unknown> = { summary: 'Ship the fix', project: 'PROJ' };
    Object.defineProperty(payload, Symbol('extra'), { value: 1, enumerable: true });
    const result = await harness.execute({ payload });
    expect(result).toEqual({ ok: false, status: 422, code: 'NON_CANONICAL_PAYLOAD' });
    expect(harness.posts()).toBe(0);
    expect(await harness.tickets()).toBe(0);
  } finally {
    await harness.stop();
  }
});
