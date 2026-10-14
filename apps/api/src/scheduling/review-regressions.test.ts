import { randomUUID } from 'node:crypto';

import { scheduleHash } from '@agent-works/domain';
import { expect, test, vi } from 'vitest';

import { createScheduler } from './service.js';
import { schedulerFixture, suspendFixture } from './test-fixtures.js';

test('server bundled capability publication admits the api runtime agent in both checks', async () => {
  const f = await schedulerFixture();
  const check = vi.spyOn(f.deps.suspension, 'check');
  const dispatch = vi.spyOn(f.deps.dispatch, 'accept');
  await f.scheduler.create(f.spec, 'alice');
  f.clock.advance(60000);
  await f.scheduler.tick();
  expect(await f.store.runs(f.spec.id)).toMatchObject([{ status: 'accepted' }]);
  expect(check).toHaveBeenCalledTimes(2);
  for (const [context] of check.mock.calls) {
    expect(context.agent).toEqual({ kind: 'agent', id: 'api', version: '1' });
    expect(context.skill).toEqual({ kind: 'skill', ...f.spec.maxPrivilege.skill });
  }
  expect(dispatch.mock.calls[0][0].agent).toEqual({
    kind: 'agent',
    agentId: 'api',
    version: '1',
    identityRef: 'agent://api',
  });
});

test.each(['window', 'suspension'] as const)(
  'lost acceptance acknowledgement followed by %s reconciles and cancels the committed task',
  async (kind) => {
    const f = await schedulerFixture({
      allowedWindow: { weekdays: [3], start: '10:00', end: '10:02' },
    });
    await f.scheduler.create(f.spec, 'alice');
    const broken = createScheduler({
      ...f.deps,
      store: { ...f.store, finish: () => Promise.reject(new Error('ack lost')) },
    });
    f.clock.advance(60000);
    await expect(broken.tick()).rejects.toThrow('ack lost');
    const [pending] = await f.store.runs(f.spec.id);
    const taskId = await f.deps.findTask('alice', `schedule:${pending.id}`);
    expect(taskId).toBeDefined();
    f.clock.advance(60000);
    if (kind === 'suspension') {
      f.clock.set('2026-10-14T10:01:30.000Z');
      await suspendFixture(f, 'global');
    }
    const dispatch = vi.spyOn(f.deps.dispatch, 'accept');
    await f.scheduler.tick();
    expect(dispatch).not.toHaveBeenCalled();
    expect((await f.store.runs(f.spec.id))[0]).toMatchObject({ status: 'cancelled', taskId });
    expect((await f.tasks.ledger.read('alice', taskId!))?.status).toBe('CANCELLED');
    expect(
      (await f.budget.events()).filter(
        (v) => v.operationId === pending.id && v.kind === 'released',
      ),
    ).toHaveLength(1);
  },
);

test.each(['completion', 'cancellation', 'denial'] as const)(
  'terminal %s retries failed budget evidence and release on later ticks',
  async (kind) => {
    const f = await schedulerFixture();
    await f.scheduler.create(f.spec, 'alice');
    f.clock.advance(60000);
    if (kind !== 'denial') await f.scheduler.tick();
    const events = vi.fn(() => f.budget.events()).mockRejectedValueOnce(new Error('evidence down'));
    const release = vi
      .fn((id: string) => f.budget.release(id))
      .mockRejectedValueOnce(new Error('release down'));
    const scheduler = createScheduler({
      ...f.deps,
      budget: { ...f.budget, events, release },
      taskStatus: kind === 'completion' ? () => Promise.resolve('COMPLETED') : f.deps.taskStatus,
      ...(kind === 'denial'
        ? {
            budget: {
              ...f.budget,
              events,
              release,
              async reserve(charge, policy) {
                const result = await f.budget.reserve(charge, policy);
                await suspendFixture(f, 'global');
                return result;
              },
            },
          }
        : {}),
    });
    if (kind === 'cancellation') {
      await expect(scheduler.change('alice', f.spec.id, 1, 'pause')).rejects.toThrow(
        'release down',
      );
      await expect(scheduler.tick()).rejects.toThrow('evidence down');
    } else {
      await expect(scheduler.tick()).rejects.toThrow('evidence down');
      await expect(scheduler.tick()).rejects.toThrow('release down');
    }
    const [run] = await f.store.runs(f.spec.id);
    expect(run.status).toBe(
      kind === 'completion' ? 'completed' : kind === 'cancellation' ? 'cancelled' : 'denied',
    );
    await scheduler.tick();
    await scheduler.tick();
    expect(
      (await f.budget.events()).filter((v) => v.operationId === run.id && v.kind === 'released'),
    ).toHaveLength(1);
  },
);

test('repeated first-schedule lookup failure does not starve later dispatch or revocation', async () => {
  const f = await schedulerFixture();
  await f.scheduler.create(f.spec, 'alice');
  const healthy = { ...f.spec, id: randomUUID(), consentRef: 'consent-healthy' };
  f.consent.grant({
    ref: healthy.consentRef,
    subject: 'alice',
    digest: scheduleHash(healthy),
    expiresAt: healthy.expiresAt,
  });
  await f.scheduler.create(healthy, 'alice');
  const scheduler = createScheduler({
    ...f.deps,
    authority: async (spec) => {
      if (spec.id === f.spec.id) throw new Error('directory down');
      return f.deps.authority(spec);
    },
  });
  f.clock.advance(60000);
  await expect(scheduler.tick()).rejects.toThrow('directory down');
  expect(await f.store.runs(f.spec.id)).toEqual([]);
  const [run] = await f.store.runs(healthy.id);
  expect(run.status).toBe('accepted');
  f.consent.revoke(healthy.consentRef);
  await expect(scheduler.tick()).rejects.toThrow('directory down');
  expect((await f.store.runs(healthy.id))[0].status).toBe('cancelled');
  expect((await f.tasks.ledger.read('alice', run.taskId!))?.status).toBe('CANCELLED');
});
