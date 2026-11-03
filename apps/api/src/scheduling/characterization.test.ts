import {
  canonicalPayloadSha256,
  parseCron,
  cronMatches,
  scheduleRunId,
  scheduleSpecSchema,
} from '@agent-works/domain';
import { describe, expect, test } from 'vitest';

import { createMemorySchedulePort } from '../ports/memory/schedule-port.js';
import { ScheduleConflict } from '../ports/schedule-port.js';

import { schedulerFixture, scheduleFixture } from './test-fixtures.js';
import { dueSlot, inAllowedWindow, localTime } from './time.js';

import type { ClaimRun } from '../ports/schedule-port.js';

const at = (iso: string) => new Date(iso);
const T0 = '2026-10-14T10:00:00.000Z';
const T1 = '2026-10-14T10:01:00.000Z';
const cronSpec = (expression: string, over: Parameters<typeof scheduleFixture>[0] = {}) =>
  scheduleFixture({ timing: { kind: 'cron', expression }, ...over });
const claimOf = (scheduleId: string, fireAt: string, owner = 'a'): ClaimRun => ({
  scheduleId,
  fireAt,
  owner,
  now: fireAt,
  leaseMs: 30000,
  event: null,
});

describe('characterization: timing grammar', () => {
  test('interval floor is exactly 60 seconds', () => {
    const timing = (everySeconds: number) =>
      scheduleFixture({ timing: { kind: 'interval', everySeconds, anchor: T0 } });
    expect(scheduleSpecSchema.safeParse(timing(60)).success).toBe(true);
    expect(scheduleSpecSchema.safeParse(timing(59)).success).toBe(false);
    expect(scheduleSpecSchema.safeParse(timing(1)).success).toBe(false);
  });

  test.each([
    '* * * *',
    '* * * * * *',
    '@daily',
    '0 0 * * MON',
    '0 0 * JAN *',
    '60 * * * *',
    '* 24 * * *',
    '* * 0 * *',
    '* * * 13 *',
    '* * * * 7',
    '*/0 * * * *',
    '5-3 * * * *',
    '',
  ])('cron %j is rejected', (expression) => {
    expect(scheduleSpecSchema.safeParse(cronSpec(expression)).success).toBe(false);
  });

  test.each(['* * * * *', '*/15 0-6 1,15 * 1-5', '0 9 * * 1-5', '5/10 * * * *'])(
    'cron %j is accepted',
    (expression) => {
      expect(scheduleSpecSchema.safeParse(cronSpec(expression)).success).toBe(true);
    },
  );

  test('day-of-month and weekday use OR when both are restricted, AND when either is wildcard', () => {
    const both = parseCron('0 0 13 * 5');
    expect(cronMatches(both, [0, 0, 13, 10, 3])).toBe(true);
    expect(cronMatches(both, [0, 0, 20, 10, 5])).toBe(true);
    expect(cronMatches(both, [0, 0, 20, 10, 3])).toBe(false);
    const dayOnly = parseCron('0 0 13 * *');
    expect(cronMatches(dayOnly, [0, 0, 13, 10, 3])).toBe(true);
    expect(cronMatches(dayOnly, [0, 0, 14, 10, 3])).toBe(false);
  });

  test('timezone must be a valid IANA zone', () => {
    expect(
      scheduleSpecSchema.safeParse(scheduleFixture({ timezone: 'Mars/Olympus' })).success,
    ).toBe(false);
    expect(
      scheduleSpecSchema.safeParse(scheduleFixture({ timezone: 'Asia/Kolkata' })).success,
    ).toBe(true);
  });

  test('half-hour offset zone resolves cron locally to a UTC slot', () => {
    const spec = cronSpec('30 12 * * *', { timezone: 'Asia/Kolkata' });
    expect(dueSlot(spec, '2026-10-14T06:59:00.000Z', at('2026-10-14T07:00:00.000Z'))).toBe(
      '2026-10-14T07:00:00.000Z',
    );
  });
});

describe('characterization: DST', () => {
  test('repeated fall-back minute yields two distinct UTC slots and two distinct run ids', () => {
    const spec = cronSpec('30 1 * * *', {
      timezone: 'America/New_York',
      expiresAt: '2026-11-03T00:00:00.000Z',
    });
    const first = dueSlot(spec, '2026-11-01T05:29:00.000Z', at('2026-11-01T05:30:00.000Z'));
    const second = dueSlot(spec, '2026-11-01T06:29:00.000Z', at('2026-11-01T06:30:00.000Z'));
    expect([first, second]).toEqual(['2026-11-01T05:30:00.000Z', '2026-11-01T06:30:00.000Z']);
    expect(scheduleRunId(spec.id, first!)).not.toBe(scheduleRunId(spec.id, second!));
  });

  test('missing spring-forward minute has no UTC slot, and the neighbouring day does', () => {
    const spec = cronSpec('30 2 * * *', {
      timezone: 'America/New_York',
      expiresAt: '2026-03-12T00:00:00.000Z',
    });
    // 2026-03-08 02:30 America/New_York never occurs. Scan every minute across the transition day.
    let hits = 0;
    for (
      let t = Date.parse('2026-03-08T05:00:00.000Z');
      t < Date.parse('2026-03-09T04:00:00.000Z');
      t += 60000
    )
      if (dueSlot(spec, new Date(t - 60000).toISOString(), new Date(t)) !== undefined) hits += 1;
    expect(hits).toBe(0);
    expect(dueSlot(spec, '2026-03-09T06:29:00.000Z', at('2026-03-09T06:30:00.000Z'))).toBe(
      '2026-03-09T06:30:00.000Z',
    );
  });

  test('localTime reports the wall clock on both sides of the repeated hour', () => {
    const a = localTime(at('2026-11-01T05:30:00.000Z'), 'America/New_York');
    const b = localTime(at('2026-11-01T06:30:00.000Z'), 'America/New_York');
    expect([a.hour, a.minute, b.hour, b.minute]).toEqual([1, 30, 1, 30]);
  });
});

describe('characterization: window, expiry, misfire', () => {
  test('window boundaries: start inclusive, end exclusive, equal bounds mean the whole day', () => {
    const spec = scheduleFixture({
      allowedWindow: { weekdays: [3], start: '09:00', end: '10:00' },
    });
    expect(inAllowedWindow(spec, at('2026-10-14T08:59:00.000Z'))).toBe(false);
    expect(inAllowedWindow(spec, at('2026-10-14T09:00:00.000Z'))).toBe(true);
    expect(inAllowedWindow(spec, at('2026-10-14T09:59:00.000Z'))).toBe(true);
    expect(inAllowedWindow(spec, at('2026-10-14T10:00:00.000Z'))).toBe(false);
    const day = scheduleFixture({ allowedWindow: { weekdays: [3], start: '00:00', end: '00:00' } });
    expect(inAllowedWindow(day, at('2026-10-14T23:59:00.000Z'))).toBe(true);
    expect(inAllowedWindow(day, at('2026-10-15T00:00:00.000Z'))).toBe(false);
  });

  test('a slot on the exclusive window end is not dispatched', () => {
    const spec = scheduleFixture({
      timing: { kind: 'interval', everySeconds: 60, anchor: '2026-10-13T00:00:00.000Z' },
      allowedWindow: { weekdays: [3], start: '09:00', end: '10:00' },
    });
    expect(
      dueSlot(spec, '2026-10-14T09:59:00.000Z', at('2026-10-14T10:00:00.000Z')),
    ).toBeUndefined();
    expect(dueSlot(spec, '2026-10-14T08:59:00.000Z', at('2026-10-14T09:00:00.000Z'))).toBe(
      '2026-10-14T09:00:00.000Z',
    );
  });

  test('expiry is exclusive: one millisecond before fires, the instant itself does not', () => {
    const spec = scheduleFixture({ expiresAt: T1 });
    expect(dueSlot(spec, '2026-10-14T09:59:00.000Z', at('2026-10-14T10:00:59.999Z'))).toBe(T0);
    expect(dueSlot(spec, T0, at(T1))).toBeUndefined();
    const later = scheduleFixture({ expiresAt: '2026-10-14T10:01:00.001Z' });
    expect(dueSlot(later, T0, at(T1))).toBe(T1);
  });

  test('skip tolerates under one minute of lateness and drops anything older', () => {
    const spec = scheduleFixture({
      timing: { kind: 'interval', everySeconds: 3600, anchor: T0 },
      misfire: 'skip',
    });
    const slot = '2026-10-14T11:00:00.000Z';
    expect(dueSlot(spec, T0, at('2026-10-14T11:00:59.999Z'))).toBe(slot);
    expect(dueSlot(spec, T0, at('2026-10-14T11:01:00.000Z'))).toBeUndefined();
  });

  test('catch-up-once picks the latest missed slot, never the earliest or a backlog', () => {
    const spec = scheduleFixture();
    expect(dueSlot(spec, T0, at('2026-10-14T10:10:05.000Z'))).toBe('2026-10-14T10:10:00.000Z');
    const cron = cronSpec('0 * * * *');
    expect(dueSlot(cron, T0, at('2026-10-14T13:20:00.000Z'))).toBe('2026-10-14T13:00:00.000Z');
  });

  test('cron catch-up looks back at most one year, so older outages are discarded', () => {
    const spec = cronSpec('0 0 29 2 *', { expiresAt: '2030-01-01T00:00:00.000Z' });
    expect(
      dueSlot(spec, '2024-01-01T00:00:00.000Z', at('2026-12-31T00:00:00.000Z')),
    ).toBeUndefined();
    expect(dueSlot(spec, '2024-01-01T00:00:00.000Z', at('2025-01-15T00:00:00.000Z'))).toBe(
      '2024-02-29T00:00:00.000Z',
    );
  });
});

describe('characterization: resume and pause on the store', () => {
  test('resume drops slots missed while paused and fires the next one', async () => {
    const f = await schedulerFixture();
    await f.scheduler.create(f.spec, 'alice');
    await f.scheduler.change('alice', f.spec.id, 1, 'pause');
    f.clock.advance(10 * 60000);
    await f.scheduler.tick();
    expect(await f.store.runs(f.spec.id)).toEqual([]);
    await f.scheduler.change('alice', f.spec.id, 2, 'resume');
    expect((await f.store.read('alice', f.spec.id))?.cursor).toBe(f.clock.now().toISOString());
    f.clock.advance(5000);
    await f.scheduler.tick();
    expect(await f.store.runs(f.spec.id)).toEqual([]);
    f.clock.advance(60000);
    await f.scheduler.tick();
    expect(await f.store.runs(f.spec.id)).toMatchObject([{ fireAt: '2026-10-14T10:11:00.000Z' }]);
  });

  test('a revoked schedule cannot be resumed and a stale revision is refused', async () => {
    const f = await schedulerFixture();
    await f.scheduler.create(f.spec, 'alice');
    await expect(f.scheduler.change('alice', f.spec.id, 9, 'pause')).rejects.toThrow(
      ScheduleConflict,
    );
    await f.scheduler.change('alice', f.spec.id, 1, 'revoke');
    await expect(f.scheduler.change('alice', f.spec.id, 2, 'resume')).rejects.toThrow(
      ScheduleConflict,
    );
  });

  test('creation at or after expiry is refused', async () => {
    const store = createMemorySchedulePort();
    const spec = scheduleFixture({ expiresAt: T0 });
    await expect(store.create(spec, 'alice', T0)).rejects.toThrow(ScheduleConflict);
  });
});

describe('characterization: occurrence identity', () => {
  test('run id is the canonical hash of schedule id, UTC slot and event key only', () => {
    const id = scheduleFixture().id;
    expect(scheduleRunId(id, T1)).toBe(
      canonicalPayloadSha256({ scheduleId: id, fireAt: T1, eventKey: null }),
    );
  });

  test('timed slot is unique; the second claim of the same slot yields nothing', async () => {
    const store = createMemorySchedulePort();
    const spec = scheduleFixture();
    await store.create(spec, 'alice', T0);
    expect(await store.claim(claimOf(spec.id, T1, 'a'))).toMatchObject({ fence: 1 });
    expect(await store.claim(claimOf(spec.id, T1, 'b'))).toBeUndefined();
    expect(await store.runs(spec.id)).toHaveLength(1);
  });

  test('non-canonical instants are refused so one slot cannot have two spellings', async () => {
    const store = createMemorySchedulePort();
    const spec = scheduleFixture();
    await store.create(spec, 'alice', T0);
    await expect(store.claim(claimOf(spec.id, '2026-10-14T10:01:00Z'))).rejects.toThrow(
      ScheduleConflict,
    );
    await expect(store.claim(claimOf(spec.id, '2026-10-14T19:01:00.000+09:00'))).rejects.toThrow(
      ScheduleConflict,
    );
  });

  test('event keys are a separate domain from the timed slot at the same instant', () => {
    const id = scheduleFixture().id;
    expect(scheduleRunId(id, T1, 'k'.repeat(64))).not.toBe(scheduleRunId(id, T1));
    expect(scheduleRunId(id, T1, 'k'.repeat(64))).not.toBe(scheduleRunId(id, T1, 'j'.repeat(64)));
  });

  test('a lapsed lease is taken over with a higher fence on the same occurrence', async () => {
    const store = createMemorySchedulePort();
    const spec = scheduleFixture();
    await store.create(spec, 'alice', T0);
    const first = await store.claim(claimOf(spec.id, T1, 'a'));
    const later = { ...claimOf(spec.id, T1, 'b'), now: '2026-10-14T10:02:00.000Z' };
    const second = await store.claim(later);
    expect([first?.id, second?.id, second?.fence]).toEqual([first?.id, first?.id, 2]);
    expect(await store.runs(spec.id)).toHaveLength(1);
  });
});
