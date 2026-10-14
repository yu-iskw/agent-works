import { expect, test } from 'vitest';

import { scheduleFixture } from './test-fixtures.js';
import { dueSlot, inAllowedWindow, localTime } from './time.js';
const at = (iso: string) => new Date(iso);
test('interval slots use anchor rather than polling drift', () => {
  const spec = scheduleFixture();
  expect(dueSlot(spec, '2026-10-14T10:00:00.000Z', at('2026-10-14T10:01:05.000Z'))).toBe(
    '2026-10-14T10:01:00.000Z',
  );
  expect(dueSlot(spec, '2026-10-14T10:01:00.000Z', at('2026-10-14T10:01:05.000Z'))).toBeUndefined();
});
test('a future anchor and backwards clock cannot fire', () => {
  const spec = scheduleFixture();
  expect(dueSlot(spec, '2026-10-14T09:00:00.000Z', at('2026-10-14T09:59:00.000Z'))).toBeUndefined();
  expect(dueSlot(spec, '2026-10-14T10:01:00.000Z', at('2026-10-14T10:00:00.000Z'))).toBeUndefined();
});
test('start is inclusive, end is exclusive in local time', () => {
  const spec = scheduleFixture({
    timezone: 'Asia/Tokyo',
    allowedWindow: { weekdays: [3], start: '09:00', end: '17:00' },
  });
  expect(inAllowedWindow(spec, at('2026-10-14T00:00:00.000Z'))).toBe(true);
  expect(inAllowedWindow(spec, at('2026-10-14T07:59:00.000Z'))).toBe(true);
  expect(inAllowedWindow(spec, at('2026-10-14T08:00:00.000Z'))).toBe(false);
  expect(inAllowedWindow(spec, at('2026-10-13T00:00:00.000Z'))).toBe(false);
});
test('overnight windows associate the post-midnight tail with the prior weekday', () => {
  const spec = scheduleFixture({ allowedWindow: { weekdays: [3], start: '22:00', end: '02:00' } });
  expect(inAllowedWindow(spec, at('2026-10-14T22:00:00.000Z'))).toBe(true);
  expect(inAllowedWindow(spec, at('2026-10-15T01:59:00.000Z'))).toBe(true);
  expect(inAllowedWindow(spec, at('2026-10-15T02:00:00.000Z'))).toBe(false);
  expect(inAllowedWindow(spec, at('2026-10-14T01:00:00.000Z'))).toBe(false);
});
test('cron resolves time in the specified timezone', () => {
  const spec = scheduleFixture({
    timezone: 'Asia/Tokyo',
    timing: { kind: 'cron', expression: '0 19 * * *' },
  });
  expect(dueSlot(spec, '2026-10-14T09:59:00.000Z', at('2026-10-14T10:00:00.000Z'))).toBe(
    '2026-10-14T10:00:00.000Z',
  );
});
test('DST repeated local minutes map to two distinct UTC slots', () => {
  const spec = scheduleFixture({
    timezone: 'America/New_York',
    timing: { kind: 'cron', expression: '30 1 * * *' },
    expiresAt: '2026-11-03T00:00:00.000Z',
  });
  expect(localTime(at('2026-11-01T05:30:00.000Z'), spec.timezone).hour).toBe(1);
  expect(localTime(at('2026-11-01T06:30:00.000Z'), spec.timezone).hour).toBe(1);
  expect(dueSlot(spec, '2026-11-01T05:29:00.000Z', at('2026-11-01T05:30:00.000Z'))).toBe(
    '2026-11-01T05:30:00.000Z',
  );
  expect(dueSlot(spec, '2026-11-01T06:29:00.000Z', at('2026-11-01T06:30:00.000Z'))).toBe(
    '2026-11-01T06:30:00.000Z',
  );
});
test('catch-up cannot dispatch a formerly allowed slot after the window closes', () => {
  const spec = scheduleFixture({ allowedWindow: { weekdays: [3], start: '09:00', end: '10:00' } });
  expect(dueSlot(spec, '2026-10-14T09:00:00.000Z', at('2026-10-14T10:01:00.000Z'))).toBeUndefined();
});
test('expiry is exclusive even when aligned to a due slot', () => {
  const spec = scheduleFixture({ expiresAt: '2026-10-14T10:01:00.000Z' });
  expect(dueSlot(spec, '2026-10-14T10:00:00.000Z', at(spec.expiresAt))).toBeUndefined();
});
