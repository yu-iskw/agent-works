import { expect, test, vi } from 'vitest';

import { createScheduler } from './service.js';
import { schedulerFixture } from './test-fixtures.js';
test.each(['consent', 'sponsor', 'pause', 'expiry'])(
  '%s revocation cancels in-flight work through existing task path',
  async (kind) => {
    const f = await schedulerFixture();
    await f.scheduler.create(f.spec, 'alice');
    f.clock.advance(60000);
    await f.scheduler.tick();
    const [run] = await f.store.runs(f.spec.id);
    if (run.taskId === null) throw new Error('task');
    expect((await f.tasks.ledger.read('alice', run.taskId))?.status).toBe('QUEUED');
    if (kind === 'consent') f.consent.revoke(f.spec.consentRef);
    if (kind === 'sponsor') f.current.active = false;
    if (kind === 'expiry') f.clock.set(f.spec.expiresAt);
    if (kind === 'pause') await f.scheduler.change('alice', f.spec.id, 1, 'pause');
    else await f.scheduler.tick();
    expect((await f.tasks.ledger.read('alice', run.taskId))?.status).toBe('CANCELLED');
    expect((await f.store.runs(f.spec.id))[0].status).toBe('cancelled');
    expect((await f.budget.events()).some((v) => v.kind === 'released')).toBe(true);
    f.clock.advance(60000);
    await f.scheduler.tick();
    expect(await f.store.runs(f.spec.id)).toHaveLength(1);
  },
);
test('resume rechecks authority and resets cursor to avoid replaying paused slots', async () => {
  const f = await schedulerFixture();
  await f.scheduler.create(f.spec, 'alice');
  await f.scheduler.change('alice', f.spec.id, 1, 'pause');
  f.clock.advance(5 * 60000);
  await f.scheduler.tick();
  await f.scheduler.change('alice', f.spec.id, 2, 'resume');
  await f.scheduler.tick();
  expect(await f.store.runs(f.spec.id)).toEqual([]);
  f.clock.advance(60000);
  await f.scheduler.tick();
  expect(await f.store.runs(f.spec.id)).toHaveLength(1);
});
test('resume cannot revive a schedule whose consent has been revoked', async () => {
  const f = await schedulerFixture();
  await f.scheduler.create(f.spec, 'alice');
  await f.scheduler.change('alice', f.spec.id, 1, 'pause');
  f.consent.revoke(f.spec.consentRef);
  await expect(f.scheduler.change('alice', f.spec.id, 2, 'resume')).rejects.toThrow(
    'CONSENT_REVOKED',
  );
  expect((await f.store.read('alice', f.spec.id))?.state).toBe('paused');
});
test('pause racing dispatcher acceptance cancels the newly linked task', async () => {
  const f = await schedulerFixture();
  await f.scheduler.create(f.spec, 'alice');
  const dispatch = vi.fn(async (input: Parameters<typeof f.deps.dispatch.accept>[0]) => {
    const accepted = await f.tasks.dispatch.accept(input);
    await f.store.change('alice', f.spec.id, 1, 'pause', f.clock.now().toISOString());
    return accepted;
  });
  const scheduler = createScheduler({ ...f.deps, dispatch: { accept: dispatch } });
  f.clock.advance(60000);
  await scheduler.tick();
  const [run] = await f.store.runs(f.spec.id);
  expect(run.status).toBe('cancelled');
  expect((await f.tasks.ledger.read('alice', run.taskId!))?.status).toBe('CANCELLED');
});
test('consent revocation racing dispatcher acceptance cancels the newly linked task', async () => {
  const f = await schedulerFixture();
  await f.scheduler.create(f.spec, 'alice');
  const scheduler = createScheduler({
    ...f.deps,
    dispatch: {
      async accept(input) {
        const accepted = await f.tasks.dispatch.accept(input);
        f.consent.revoke(f.spec.consentRef);
        return accepted;
      },
    },
  });
  f.clock.advance(60000);
  await scheduler.tick();
  expect(await f.store.runs(f.spec.id)).toMatchObject([
    { status: 'cancelled', reason: 'CONSENT_REVOKED' },
  ]);
});
test('a failed cancellation is retried on the next tick without marking success', async () => {
  const f = await schedulerFixture();
  await f.scheduler.create(f.spec, 'alice');
  f.clock.advance(60000);
  await f.scheduler.tick();
  f.consent.revoke(f.spec.consentRef);
  const broken = createScheduler({
    ...f.deps,
    cancel: () => Promise.reject(new Error('cancel down')),
  });
  await expect(broken.tick()).rejects.toThrow('cancel down');
  expect((await f.store.runs(f.spec.id))[0].status).toBe('accepted');
  await f.scheduler.tick();
  expect((await f.store.runs(f.spec.id))[0].status).toBe('cancelled');
});
test('terminal tasks release scheduler concurrency on reconciliation', async () => {
  const f = await schedulerFixture();
  await f.scheduler.create(f.spec, 'alice');
  f.clock.advance(60000);
  await f.scheduler.tick();
  const scheduler = createScheduler({ ...f.deps, taskStatus: () => Promise.resolve('COMPLETED') });
  await scheduler.tick();
  expect((await f.store.runs(f.spec.id))[0].status).toBe('completed');
  expect((await f.budget.events()).some((v) => v.kind === 'released')).toBe(true);
});
