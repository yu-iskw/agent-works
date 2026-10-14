import { expect, test, vi } from 'vitest';

import { createScheduler } from './service.js';
import { schedulerFixture, suspendFixture } from './test-fixtures.js';

test.each(['expiry', 'window', 'consent', 'authority', 'pause', 'suspension'])(
  '%s changing during budget admission cannot start work',
  async (kind) => {
    const f = await schedulerFixture(
      kind === 'window' ? { allowedWindow: { weekdays: [3], start: '10:00', end: '11:00' } } : {},
    );
    await f.scheduler.create(f.spec, 'alice');
    const dispatch = vi.fn(f.deps.dispatch.accept);
    const scheduler = createScheduler({
      ...f.deps,
      dispatch: { accept: dispatch },
      budget: {
        ...f.budget,
        async reserve(charge, policy) {
          const reservation = await f.budget.reserve(charge, policy);
          if (kind === 'expiry') f.clock.set(f.spec.expiresAt);
          if (kind === 'window') f.clock.set('2026-10-14T23:00:00.000Z');
          if (kind === 'consent') f.consent.revoke(f.spec.consentRef);
          if (kind === 'authority') f.current.privilege.scopes = [];
          if (kind === 'pause') {
            await f.store.change('alice', f.spec.id, 1, 'pause', f.clock.now().toISOString());
          }
          if (kind === 'suspension') await suspendFixture(f, 'global');
          return reservation;
        },
      },
    });
    f.clock.advance(60000);
    await scheduler.tick();
    expect(dispatch).not.toHaveBeenCalled();
    const [run] = await f.store.runs(f.spec.id);
    expect(run.status).toBe('denied');
    expect(run.taskId).toBeNull();
    expect((await f.budget.events()).filter((event) => event.kind === 'released')).toHaveLength(1);
  },
);

test('authority loss retains a specific reason in revocation audit evidence', async () => {
  const f = await schedulerFixture();
  await f.scheduler.create(f.spec, 'alice');
  f.current.privilege.sources = [];
  f.clock.advance(60000);
  await f.scheduler.tick();
  expect(await f.store.history('alice')).toMatchObject([
    { kind: 'created', reason: null },
    { kind: 'revoked', reason: 'SPONSOR_AUTHORITY_LOST' },
  ]);
});

test('expiry while dispatch commits cancels the accepted task', async () => {
  const f = await schedulerFixture();
  await f.scheduler.create(f.spec, 'alice');
  const scheduler = createScheduler({
    ...f.deps,
    dispatch: {
      async accept(input) {
        const accepted = await f.deps.dispatch.accept(input);
        f.clock.set(f.spec.expiresAt);
        return accepted;
      },
    },
  });
  f.clock.advance(60000);
  await scheduler.tick();
  const [run] = await f.store.runs(f.spec.id);
  expect(run).toMatchObject({ status: 'cancelled', reason: 'EXPIRED' });
  expect((await f.tasks.ledger.read('alice', run.taskId!))?.status).toBe('CANCELLED');
});

test.each(['pause', 'consent', 'sponsor', 'expiry'])(
  '%s cancels a task committed before schedule completion acknowledgement',
  async (kind) => {
    const f = await schedulerFixture();
    await f.scheduler.create(f.spec, 'alice');
    const scheduler = createScheduler({
      ...f.deps,
      store: {
        ...f.store,
        finish: () => Promise.reject(new Error('completion acknowledgement lost')),
      },
    });
    f.clock.advance(60000);
    await expect(scheduler.tick()).rejects.toThrow('completion acknowledgement lost');
    const [pending] = await f.store.runs(f.spec.id);
    expect(pending.status).toBe('dispatching');
    expect(pending.taskId).toBeNull();
    const taskId = await f.deps.findTask('alice', `schedule:${pending.id}`);
    expect(taskId).toBeDefined();
    if (kind === 'pause') await f.scheduler.change('alice', f.spec.id, 1, 'pause');
    if (kind === 'consent') f.consent.revoke(f.spec.consentRef);
    if (kind === 'sponsor') f.current.active = false;
    if (kind === 'expiry') f.clock.set(f.spec.expiresAt);
    await f.scheduler.tick();
    expect(await f.store.runs(f.spec.id)).toMatchObject([{ status: 'cancelled', taskId }]);
    expect((await f.tasks.ledger.read('alice', taskId!))?.status).toBe('CANCELLED');
    expect(await f.store.runs(f.spec.id)).toHaveLength(1);
  },
);

test('revocation does not replay dispatch when no committed task can be found', async () => {
  const f = await schedulerFixture();
  await f.scheduler.create(f.spec, 'alice');
  const dispatch = vi.fn(() => Promise.reject(new Error('dispatch unavailable')));
  const scheduler = createScheduler({ ...f.deps, dispatch: { accept: dispatch } });
  f.clock.advance(60000);
  await expect(scheduler.tick()).rejects.toThrow('workflow dispatch incomplete');
  const calls = dispatch.mock.calls.length;
  f.consent.revoke(f.spec.consentRef);
  await scheduler.tick();
  f.clock.advance(60000);
  await scheduler.tick();
  expect(dispatch).toHaveBeenCalledTimes(calls);
  expect(await f.store.runs(f.spec.id)).toMatchObject([{ status: 'dispatching', taskId: null }]);
});

test('concurrent revocation reconciliation cancels one task idempotently', async () => {
  const f = await schedulerFixture();
  await f.scheduler.create(f.spec, 'alice');
  f.clock.advance(60000);
  await f.scheduler.tick();
  f.consent.revoke(f.spec.consentRef);
  await Promise.all([f.scheduler.tick(), createScheduler({ ...f.deps, owner: 'second' }).tick()]);
  expect(await f.store.runs(f.spec.id)).toMatchObject([{ status: 'cancelled' }]);
  expect((await f.budget.events()).filter((event) => event.kind === 'released')).toHaveLength(1);
});

test.each(['COMPLETED', 'FAILED', 'CANCELLED'] as const)(
  'revocation reconciles an already %s task without calling cancellation',
  async (status) => {
    const f = await schedulerFixture();
    await f.scheduler.create(f.spec, 'alice');
    f.clock.advance(60000);
    await f.scheduler.tick();
    f.consent.revoke(f.spec.consentRef);
    const cancel = vi.fn(f.deps.cancel);
    const scheduler = createScheduler({
      ...f.deps,
      cancel,
      taskStatus: () => Promise.resolve(status),
    });
    await scheduler.tick();
    expect(cancel).not.toHaveBeenCalled();
    expect(await f.store.runs(f.spec.id)).toMatchObject([
      { status: status === 'CANCELLED' ? 'cancelled' : 'completed', reason: status },
    ]);
    expect((await f.budget.events()).filter((event) => event.kind === 'released')).toHaveLength(1);
  },
);
