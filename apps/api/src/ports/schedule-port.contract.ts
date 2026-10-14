import { sourceEventKey, scheduleRunId, scheduleHash } from '@agent-works/domain';
import { describe, expect, test } from 'vitest';

import { scheduleFixture, eventTriggerFixture } from '../scheduling/test-fixtures.js';

import { ScheduleConflict } from './schedule-port.js';

import type { SchedulePort, ClaimRun } from './schedule-port.js';
const at = '2026-10-14T10:00:00.000Z';
const fireAt = '2026-10-14T10:01:00.000Z';
function claim(scheduleId: string): ClaimRun {
  return { scheduleId, fireAt, owner: 'worker-a', now: fireAt, leaseMs: 30000, event: null };
}
export function schedulePortContract(make: () => SchedulePort): void {
  describe('shared schedule adapter contract', () => {
    test('creation persists the complete immutable spec and audit digest', async () => {
      const port = make();
      const spec = scheduleFixture();
      const row = await port.create(spec, 'alice', at);
      expect(row).toMatchObject({
        spec,
        digest: scheduleHash(spec),
        state: 'active',
        revision: 1,
        cursor: at,
      });
      expect(await port.list('alice')).toEqual([row]);
      expect(await port.list('bob')).toEqual([]);
      expect(await port.history('alice')).toMatchObject([{ kind: 'created', digest: row.digest }]);
    });
    test('identical create is idempotent but reused IDs reject changed data', async () => {
      const port = make();
      const spec = scheduleFixture();
      const row = await port.create(spec, 'alice', at);
      expect(await port.create(spec, 'alice', at)).toEqual(row);
      await expect(
        port.create({ ...spec, purpose: 'different' }, 'alice', at),
      ).rejects.toBeInstanceOf(ScheduleConflict);
      expect(await port.history('alice')).toHaveLength(1);
    });
    test('owner and expiry rejection leaves no partial rows', async () => {
      const port = make();
      const spec = scheduleFixture();
      await expect(port.create(spec, 'bob', at)).rejects.toThrow();
      await expect(port.create({ ...spec, expiresAt: at }, 'alice', at)).rejects.toThrow();
      expect(await port.all()).toEqual([]);
    });
    test('owner reads cannot enumerate another sponsor', async () => {
      const port = make();
      const spec = scheduleFixture();
      await port.create(spec, 'alice', at);
      expect(await port.read('bob', spec.id)).toBeUndefined();
      expect(await port.history('bob')).toEqual([]);
    });
    test('optimistic pause/resume updates preserve spec and append audit', async () => {
      const port = make();
      const spec = scheduleFixture();
      const row = await port.create(spec, 'alice', at);
      const paused = await port.change('alice', spec.id, 1, 'pause', fireAt);
      expect(paused).toMatchObject({
        state: 'paused',
        revision: 2,
        spec: row.spec,
        digest: row.digest,
      });
      await expect(port.change('alice', spec.id, 1, 'resume', fireAt)).rejects.toBeInstanceOf(
        ScheduleConflict,
      );
      expect(await port.change('alice', spec.id, 2, 'resume', fireAt)).toMatchObject({
        state: 'active',
        revision: 3,
        cursor: fireAt,
      });
      expect((await port.history('alice')).map((v) => v.kind)).toEqual([
        'created',
        'paused',
        'resumed',
      ]);
    });
    test('concurrent changes allow one revision winner', async () => {
      const port = make();
      const spec = scheduleFixture();
      await port.create(spec, 'alice', at);
      const results = await Promise.allSettled([
        port.change('alice', spec.id, 1, 'pause', fireAt),
        port.change('alice', spec.id, 1, 'revoke', fireAt),
      ]);
      expect(results.filter((v) => v.status === 'fulfilled')).toHaveLength(1);
      expect(await port.history('alice')).toHaveLength(2);
    });
    test('revocation is permanent and cannot resume', async () => {
      const port = make();
      const spec = scheduleFixture();
      await port.create(spec, 'alice', at);
      await port.change('alice', spec.id, 1, 'revoke', fireAt);
      await expect(port.change('alice', spec.id, 2, 'resume', fireAt)).rejects.toThrow('permanent');
      expect(await port.claim(claim(spec.id))).toBeUndefined();
    });
    test('pause and expiry prevent claims', async () => {
      const port = make();
      const spec = scheduleFixture();
      await port.create(spec, 'alice', at);
      await port.change('alice', spec.id, 1, 'pause', fireAt);
      expect(await port.claim(claim(spec.id))).toBeUndefined();
      await port.change('alice', spec.id, 2, 'resume', fireAt);
      expect(await port.claim({ ...claim(spec.id), now: spec.expiresAt })).toBeUndefined();
    });
  });
  scheduleLeaseContract(make);
}
function scheduleLeaseContract(make: () => SchedulePort): void {
  describe('shared lease and event contract', () => {
    test('two workers claim one slot exactly once', async () => {
      const port = make();
      const spec = scheduleFixture();
      await port.create(spec, 'alice', at);
      const results = await Promise.all([
        port.claim(claim(spec.id)),
        port.claim({ ...claim(spec.id), owner: 'worker-b' }),
      ]);
      expect(results.filter((v) => v !== undefined)).toHaveLength(1);
      expect(await port.runs(spec.id)).toHaveLength(1);
    });
    test('lease takeover increments fence and rejects the old worker', async () => {
      const port = make();
      const spec = scheduleFixture();
      await port.create(spec, 'alice', at);
      const first = await port.claim(claim(spec.id));
      if (first === undefined) throw new Error('claim');
      const second = await port.claim({
        ...claim(spec.id),
        owner: 'worker-b',
        now: '2026-10-14T10:01:30.000Z',
      });
      if (second === undefined) throw new Error('takeover');
      expect(second.fence).toBe(2);
      await expect(
        port.finish(
          first,
          { status: 'accepted', taskId: 'task-1', reason: null },
          second.updatedAt,
        ),
      ).rejects.toThrow('fence');
      expect(
        await port.finish(
          second,
          { status: 'accepted', taskId: 'task-1', reason: null },
          second.updatedAt,
        ),
      ).toMatchObject({ status: 'accepted', fence: 2 });
    });
    test('completed slot never fires again after lease expiry', async () => {
      const port = make();
      const spec = scheduleFixture();
      await port.create(spec, 'alice', at);
      const run = await port.claim(claim(spec.id));
      if (run === undefined) throw new Error('claim');
      await port.finish(
        run,
        { status: 'denied', taskId: null, reason: 'BUDGET_EXHAUSTED' },
        fireAt,
      );
      expect(
        await port.claim({ ...claim(spec.id), now: '2026-10-14T10:02:00.000Z' }),
      ).toBeUndefined();
    });
    test('accepted runs support idempotent cancellation and immutable terminals', async () => {
      const port = make();
      const spec = scheduleFixture();
      await port.create(spec, 'alice', at);
      const run = await port.claim(claim(spec.id));
      if (run === undefined) throw new Error('claim');
      const accepted = await port.finish(
        run,
        { status: 'accepted', taskId: 'task-1', reason: null },
        fireAt,
      );
      const result = { status: 'cancelled' as const, taskId: 'task-1', reason: 'CONSENT_REVOKED' };
      const cancelled = await port.finish(accepted, result, fireAt);
      expect(await port.finish(accepted, result, fireAt)).toEqual(cancelled);
      await expect(
        port.finish(accepted, { status: 'accepted', taskId: 'task-2', reason: null }, fireAt),
      ).rejects.toThrow('terminal');
      expect((await port.history('alice')).map((v) => v.kind)).toEqual([
        'created',
        'claimed',
        'accepted',
        'cancelled',
      ]);
    });
    test('cursor only advances and rejects invalid timestamps', async () => {
      const port = make();
      const spec = scheduleFixture();
      await port.create(spec, 'alice', at);
      await port.advance(spec.id, fireAt);
      await port.advance(spec.id, at);
      expect((await port.read('alice', spec.id))?.cursor).toBe(fireAt);
      await expect(port.advance(spec.id, 'invalid')).rejects.toThrow();
    });
    test('trigger registration is atomic and rejects mismatched schedule', async () => {
      const port = make();
      const spec = scheduleFixture();
      const trigger = eventTriggerFixture(scheduleFixture().id);
      await expect(port.create(spec, 'alice', at, trigger)).rejects.toThrow();
      expect(await port.all()).toEqual([]);
      trigger.scheduleId = spec.id;
      await port.create(spec, 'alice', at, trigger);
      expect(await port.trigger(trigger.id)).toEqual(trigger);
      expect(await port.triggers('bob')).toEqual([]);
    });
    test('received events dedupe source ID atomically with their run', async () => {
      const port = make();
      const spec = scheduleFixture();
      const trigger = eventTriggerFixture(spec.id);
      await port.create(spec, 'alice', at, trigger);
      const key = sourceEventKey(trigger.source, 'event-1');
      const event = {
        key,
        triggerId: trigger.id,
        scheduleId: spec.id,
        source: trigger.source,
        eventId: 'event-1',
        timestamp: fireAt,
        receivedAt: fireAt,
        digest: 'a'.repeat(64),
        trust: 'untrusted' as const,
        payload: { incidentId: 'inc-1' },
        runId: scheduleRunId(spec.id, fireAt, key),
      };
      const results = await Promise.all([
        port.claim({ ...claim(spec.id), event }),
        port.claim({ ...claim(spec.id), owner: 'b', event }),
      ]);
      expect(results.filter((v) => v !== undefined)).toHaveLength(1);
      expect(await port.received(trigger.source, 'event-1')).toEqual(event);
      expect(await port.eventForRun(event.runId)).toEqual(event);
      await expect(
        port.claim({ ...claim(spec.id), event: { ...event, digest: 'b'.repeat(64) } }),
      ).rejects.toThrow('replay');
      expect(await port.runs(spec.id)).toHaveLength(1);
    });
    test('different events with the same timestamp remain distinct', async () => {
      const port = make();
      const spec = scheduleFixture();
      const trigger = eventTriggerFixture(spec.id);
      await port.create(spec, 'alice', at, trigger);
      for (const eventId of ['one', 'two']) {
        const key = sourceEventKey(trigger.source, eventId);
        await port.claim({
          ...claim(spec.id),
          event: {
            key,
            triggerId: trigger.id,
            scheduleId: spec.id,
            source: trigger.source,
            eventId,
            timestamp: fireAt,
            receivedAt: fireAt,
            digest: 'a'.repeat(64),
            trust: 'untrusted',
            payload: { incidentId: 'inc-1' },
            runId: scheduleRunId(spec.id, fireAt, key),
          },
        });
      }
      expect(await port.runs(spec.id)).toHaveLength(2);
    });
    test('future claims and malformed leases cannot write partial evidence', async () => {
      const port = make();
      const spec = scheduleFixture();
      await port.create(spec, 'alice', at);
      expect(await port.claim({ ...claim(spec.id), now: at })).toBeUndefined();
      await expect(port.claim({ ...claim(spec.id), leaseMs: 0 })).rejects.toThrow();
      expect(await port.runs(spec.id)).toEqual([]);
      expect(await port.history('alice')).toHaveLength(1);
    });
    test('returned values cannot mutate store-owned objects', async () => {
      const port = make();
      const spec = scheduleFixture();
      const row = await port.create(spec, 'alice', at);
      row.spec.purpose = 'mutated';
      const rows = await port.list('alice');
      rows[0].spec.maxPrivilege.scopes.push('admin');
      expect((await port.read('alice', spec.id))?.spec).toEqual(spec);
    });
  });
}
