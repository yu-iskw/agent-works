import { expect, test } from 'vitest';

import { scheduleFixture } from './schedule-fixtures.js';
import { scheduleRunId, scheduleRunSchema } from './schedule-run.js';
test('run identities distinguish time slots and event receipts', () => {
  const id = scheduleFixture().id;
  const at = '2026-10-14T10:01:00.000Z';
  expect(scheduleRunId(id, at)).toBe(scheduleRunId(id, at));
  expect(scheduleRunId(id, at, 'event-1')).not.toBe(scheduleRunId(id, at));
  expect(scheduleRunId(id, at, 'event-2')).not.toBe(scheduleRunId(id, at, 'event-1'));
  expect(scheduleRunId(id, '2026-10-14T10:02:00.000Z')).not.toBe(scheduleRunId(id, at));
});
test('fencing tokens must be positive integers', () => {
  const scheduleId = scheduleFixture().id;
  const at = '2026-10-14T10:01:00.000Z';
  const row = {
    id: scheduleRunId(scheduleId, at),
    scheduleId,
    fireAt: at,
    status: 'dispatching',
    taskId: null,
    reason: null,
    leaseOwner: 'a',
    leaseUntil: at,
    fence: 1,
    createdAt: at,
    updatedAt: at,
    eventKey: null,
  };
  expect(scheduleRunSchema.safeParse(row).success).toBe(true);
  expect(scheduleRunSchema.safeParse({ ...row, fence: 0 }).success).toBe(false);
  expect(scheduleRunSchema.safeParse({ ...row, fence: 1.2 }).success).toBe(false);
});
