import { expect, test } from 'vitest';

import { scheduleFixture } from './schedule-fixtures.js';
import { scheduleHash, scheduleRecordSchema, scheduleSpecSchema } from './schedule.js';

function record() {
  const spec = scheduleFixture();
  const at = '2026-10-14T10:00:00.000Z';
  return {
    spec,
    digest: scheduleHash(spec),
    state: 'active',
    revision: 1,
    createdAt: at,
    updatedAt: at,
    cursor: at,
  };
}

test('persisted schedule digest must match the exact pinned specification', () => {
  const row = record();
  expect(scheduleRecordSchema.safeParse(row).success).toBe(true);
  expect(scheduleRecordSchema.safeParse({ ...row, digest: '0'.repeat(64) }).success).toBe(false);
  expect(
    scheduleRecordSchema.safeParse({ ...row, spec: { ...row.spec, purpose: 'tampered' } }).success,
  ).toBe(false);
});

test('JSON round-trip preserves schedule hash and excludes undefined optional fields', () => {
  const spec = scheduleFixture();
  const json: unknown = JSON.parse(JSON.stringify(spec));
  expect(scheduleHash(scheduleSpecSchema.parse(json))).toBe(scheduleHash(spec));
  const withoutInput = { ...spec, task: { ...spec.task, input: undefined } };
  const parsed = scheduleSpecSchema.parse(JSON.parse(JSON.stringify(withoutInput)) as unknown);
  expect(scheduleHash(parsed)).toBe(scheduleHash(withoutInput));
});

test.each(['sponsor', 'task', 'maxPrivilege', 'allowedWindow', 'timing', 'revocation'])(
  '%s nested contract rejects permission-bearing extensions',
  (field) => {
    const spec = scheduleFixture();
    const values = new Map(Object.entries(spec));
    const prior: unknown = values.get(field);
    if (prior === null || typeof prior !== 'object') throw new Error('fixture object missing');
    expect(
      scheduleSpecSchema.safeParse({ ...spec, [field]: { ...prior, grantAdmin: true } }).success,
    ).toBe(false);
  },
);

test.each(['24:00', '9:00', '00:60', '', '10:00:00'])(
  'window boundary %s must use bounded HH:mm',
  (start) => {
    const spec = scheduleFixture();
    expect(
      scheduleSpecSchema.safeParse({ ...spec, allowedWindow: { ...spec.allowedWindow, start } })
        .success,
    ).toBe(false);
  },
);
