import { expect, it, vi } from 'vitest';

import { createApprovalHarness, useApprovalDatabase } from './broker-harness.js';

const database = useApprovalDatabase();

it.each([
  { id: 'call-1', idempotencyKey: 'key-2' },
  { id: 'call-2', idempotencyKey: 'key-1' },
])('returns DUPLICATE_CALL for concurrent claims with $id and $idempotencyKey', async (patch) => {
  const sql = database.sql();
  const first = await createApprovalHarness(sql);
  const second = await createApprovalHarness(sql);
  let unlock!: () => void;
  let locked!: () => void;
  const released = new Promise<void>((resolve) => {
    unlock = resolve;
  });
  const acquired = new Promise<void>((resolve) => {
    locked = resolve;
  });
  const holding = sql.begin(async (tx) => {
    await tx`lock table tool_calls in share mode`;
    locked();
    await released;
  });
  let pending: Promise<unknown> | undefined;
  try {
    await first.save(first.row());
    await second.save(second.row({ id: 'apr-2', taskId: 'tsk-2' }));
    await acquired;
    const executions = Promise.all([
      first.execute(),
      second.execute({ ...patch, approvalId: 'apr-2', taskId: 'tsk-2' }),
    ]);
    pending = executions;
    await vi.waitFor(async () => {
      const rows = await sql<{ count: number }[]>`
        select count(*)::int as count from pg_stat_activity
        where datname = current_database() and wait_event_type = 'Lock'
          and query like '%insert into tool_calls%'
      `;
      expect(rows[0].count).toBe(2);
    });
    unlock();
    await holding;
    const results = await executions;
    expect(results).toContainEqual({ ok: true, receipt: 'FAKE-1', replay: false });
    expect(results).toContainEqual({ ok: false, status: 409, code: 'DUPLICATE_CALL' });
    expect(first.posts() + second.posts()).toBe(1);
    const approvals = await Promise.all([first.read('apr-1'), second.read('apr-2')]);
    expect(approvals.map((approval) => approval?.executionsUsed)).toEqual(
      expect.arrayContaining([0, 1]),
    );
  } finally {
    unlock();
    await holding;
    await pending?.catch(() => undefined);
    await first.stop();
    await second.stop();
  }
});

it.each([{}, { idempotencyKey: 'key-2' }, { id: 'call-2' }])(
  'rejects a retry while the ticket post is active: %j',
  async (patch) => {
    const harness = await createApprovalHarness(database.sql());
    const gate = harness.pauseNextPost();
    let active: ReturnType<typeof harness.execute> | undefined;
    try {
      await harness.save(harness.row());
      active = harness.execute();
      await gate.started;
      expect(await harness.execute(patch)).toEqual({
        ok: false,
        status: 409,
        code: 'DUPLICATE_CALL',
      });
      expect(harness.posts()).toBe(1);
      gate.resume();
      expect(await active).toEqual({ ok: true, receipt: 'FAKE-1', replay: false });
      expect(await harness.execute()).toEqual({ ok: true, receipt: 'FAKE-1', replay: true });
      expect(harness.posts()).toBe(1);
      expect(await harness.tickets()).toBe(1);
      expect(await harness.read('apr-1')).toMatchObject({ executionsUsed: 1 });
    } finally {
      gate.resume();
      await active?.catch(() => undefined);
      await harness.stop();
    }
  },
);

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
