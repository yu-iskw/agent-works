import { scheduleHash } from '@agent-works/domain';
import { describe, expect, test, vi } from 'vitest';

import { createScheduler } from './service.js';
import { schedulerFixture, suspendFixture } from './test-fixtures.js';
describe('scheduled task admission and concurrent firing', () => {
  test('two instances fire exactly once per slot and use the pinned template', async () => {
    const f = await schedulerFixture();
    await f.scheduler.create(f.spec, 'alice');
    const dispatch = vi.fn(f.deps.dispatch.accept);
    f.deps.dispatch = { accept: dispatch };
    const first = createScheduler(f.deps);
    const second = createScheduler({ ...f.deps, owner: 'worker-b' });
    f.clock.advance(60000);
    await Promise.all([first.tick(), second.tick()]);
    await first.tick();
    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(dispatch.mock.calls[0][0]).toMatchObject({
      subject: 'alice',
      request: f.spec.task,
      context: {
        allowedSources: ['incidents'],
        classificationCeiling: 'INTERNAL',
        allowedRegions: ['asia-northeast1'],
      },
    });
    expect(await f.store.runs(f.spec.id)).toMatchObject([
      { status: 'accepted', fireAt: f.clock.now().toISOString() },
    ]);
    f.clock.advance(60000);
    await Promise.all([first.tick(), second.tick()]);
    expect(dispatch).toHaveBeenCalledTimes(2);
  });
  test('creation rejects a ceiling outside current sponsor authority without persistent evidence', async () => {
    const f = await schedulerFixture();
    f.current.privilege.scopes = [];
    await expect(f.scheduler.create(f.spec, 'alice')).rejects.toThrow('SPONSOR_AUTHORITY_LOST');
    expect(await f.store.all()).toEqual([]);
  });
  test('creation requires trusted consent pinned to the exact canonical spec', async () => {
    const f = await schedulerFixture();
    f.consent.revoke(f.spec.consentRef);
    await expect(f.scheduler.create(f.spec, 'alice')).rejects.toThrow('CONSENT_REVOKED');
    f.consent.grant({
      ref: f.spec.consentRef,
      subject: 'alice',
      digest: scheduleHash({ ...f.spec, purpose: 'other' }),
      expiresAt: f.spec.expiresAt,
    });
    await expect(f.scheduler.create(f.spec, 'alice')).rejects.toThrow('CONSENT_REVOKED');
  });
  test('creation cannot impersonate a sponsor', async () => {
    const f = await schedulerFixture();
    await expect(f.scheduler.create(f.spec, 'bob')).rejects.toThrow('SPONSOR_MISMATCH');
    expect(await f.store.all()).toEqual([]);
  });
  test.each(['active', 'scopes', 'skill', 'classification', 'region', 'budget', 'deadline'])(
    'loss of %s authority stops future runs with audit',
    async (field) => {
      const f = await schedulerFixture();
      await f.scheduler.create(f.spec, 'alice');
      if (field === 'active') f.current.active = false;
      if (field === 'scopes') f.current.privilege.scopes = [];
      if (field === 'skill') f.current.privilege.skill.version = 'other';
      if (field === 'classification') f.current.privilege.classification = 'PUBLIC';
      if (field === 'region') f.current.privilege.regions = [];
      if (field === 'budget') f.current.privilege.budgetUsd = 0;
      if (field === 'deadline') f.current.privilege.deadlineSeconds = 1;
      f.clock.advance(60000);
      await f.scheduler.tick();
      expect(await f.store.runs(f.spec.id)).toEqual([]);
      expect((await f.store.read('alice', f.spec.id))?.state).toBe('revoked');
      expect((await f.store.history('alice')).at(-1)?.kind).toBe('revoked');
    },
  );
  test.each(['global', 'team', 'skill', 'user', 'agent', 'model'] as const)(
    '%s suspension blocks fire with denial evidence',
    async (scope) => {
      const f = await schedulerFixture();
      await f.scheduler.create(f.spec, 'alice');
      await suspendFixture(f, scope);
      f.clock.advance(60000);
      await f.scheduler.tick();
      expect(await f.store.runs(f.spec.id)).toMatchObject([
        { status: 'denied', reason: 'INVOCATION_SUSPENDED', taskId: null },
      ]);
      expect((await f.suspensionLedger.history()).at(-1)?.eventType).toBe('invocation.denied');
    },
  );
  test('budget exhaustion blocks the fire, leaves no task, and records a denial', async () => {
    const f = await schedulerFixture();
    f.deps.budgetPolicy = {
      ...f.deps.budgetPolicy,
      user: { ...f.deps.budgetPolicy.user, estimatedCostMicros: 0 },
    };
    const scheduler = createScheduler(f.deps);
    await scheduler.create(f.spec, 'alice');
    f.clock.advance(60000);
    await scheduler.tick();
    expect(await f.store.runs(f.spec.id)).toMatchObject([
      { status: 'denied', reason: 'BUDGET_EXHAUSTED', taskId: null },
    ]);
    expect(await f.budget.events()).toMatchObject([
      { kind: 'exceeded', dimension: 'estimatedCostMicros' },
    ]);
  });
  test('nothing fires outside the allowed window or after exact expiry', async () => {
    const f = await schedulerFixture({
      allowedWindow: { weekdays: [3], start: '11:00', end: '12:00' },
    });
    await f.scheduler.create(f.spec, 'alice');
    f.clock.advance(60000);
    await f.scheduler.tick();
    expect(await f.store.runs(f.spec.id)).toEqual([]);
    f.clock.set(f.spec.expiresAt);
    await f.scheduler.tick();
    expect(await f.store.runs(f.spec.id)).toEqual([]);
    expect((await f.store.read('alice', f.spec.id))?.state).toBe('revoked');
  });
  test('catch-up-once emits one latest slot after an outage', async () => {
    const f = await schedulerFixture();
    await f.scheduler.create(f.spec, 'alice');
    f.clock.advance(10 * 60000 + 5000);
    await f.scheduler.tick();
    expect(await f.store.runs(f.spec.id)).toMatchObject([{ fireAt: '2026-10-14T10:10:00.000Z' }]);
    await f.scheduler.tick();
    expect(await f.store.runs(f.spec.id)).toHaveLength(1);
  });
  test('skip drops missed hourly slots', async () => {
    const f = await schedulerFixture({
      timing: { kind: 'interval', everySeconds: 3600, anchor: '2026-10-14T10:00:00.000Z' },
      misfire: 'skip',
    });
    await f.scheduler.create(f.spec, 'alice');
    f.clock.advance(3600000 + 60000);
    await f.scheduler.tick();
    expect(await f.store.runs(f.spec.id)).toEqual([]);
  });
  test('transient authority lookup failure does not revoke a valid schedule', async () => {
    const f = await schedulerFixture();
    await f.scheduler.create(f.spec, 'alice');
    const scheduler = createScheduler({
      ...f.deps,
      authority: () => Promise.reject(new Error('directory down')),
    });
    f.clock.advance(60000);
    await expect(scheduler.tick()).rejects.toThrow('directory down');
    expect((await f.store.read('alice', f.spec.id))?.state).toBe('active');
    expect(await f.store.runs(f.spec.id)).toEqual([]);
  });
  test('unknown errors retain a recoverable lease rather than fabricate a terminal denial', async () => {
    const f = await schedulerFixture();
    await f.scheduler.create(f.spec, 'alice');
    const scheduler = createScheduler({
      ...f.deps,
      budget: { ...f.budget, reserve: () => Promise.reject(new Error('budget down')) },
    });
    f.clock.advance(60000);
    await expect(scheduler.tick()).rejects.toThrow('budget down');
    expect(await f.store.runs(f.spec.id)).toMatchObject([{ status: 'dispatching', fence: 1 }]);
    f.clock.advance(30000);
    await f.scheduler.tick();
    expect(await f.store.runs(f.spec.id)).toMatchObject([{ status: 'accepted', fence: 2 }]);
  });
});
