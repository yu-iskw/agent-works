import { describe, expect, test } from 'vitest';

import { scheduleFixture } from './schedule-fixtures.js';
import {
  scheduleHash,
  scheduleSpecSchema,
  privilegeWithin,
  scheduleRecordSchema,
} from './schedule.js';
describe('schedule domain contract', () => {
  test('round trips a complete sponsored specification and stable digest', () => {
    const spec = scheduleFixture();
    expect(scheduleSpecSchema.parse(spec)).toEqual(spec);
    expect(scheduleHash(spec)).toHaveLength(64);
    expect(scheduleHash({ ...spec, purpose: spec.purpose })).toBe(scheduleHash(spec));
    expect(scheduleHash({ ...spec, purpose: 'Changed purpose' })).not.toBe(scheduleHash(spec));
  });
  test.each(['UTC', 'Asia/Tokyo', 'America/New_York', 'Europe/London'])(
    'accepts IANA timezone %s',
    (timezone) => {
      expect(scheduleSpecSchema.safeParse(scheduleFixture({ timezone })).success).toBe(true);
    },
  );
  test.each(['Mars/Base', '', 'UTC+25'])('rejects invalid timezone %s', (timezone) => {
    expect(scheduleSpecSchema.safeParse(scheduleFixture({ timezone })).success).toBe(false);
  });
  test.each(['id', 'purpose', 'consentRef', 'expiresAt'])('rejects empty %s', (key) => {
    const spec = { ...scheduleFixture(), [key]: '' };
    expect(scheduleSpecSchema.safeParse(spec).success).toBe(false);
  });
  test('rejects unknown authority fields at the top level', () => {
    expect(scheduleSpecSchema.safeParse({ ...scheduleFixture(), scopes: ['admin'] }).success).toBe(
      false,
    );
  });
  test('service principals cannot pretend to be sponsors', () => {
    expect(
      scheduleSpecSchema.safeParse({
        ...scheduleFixture(),
        sponsor: { kind: 'serviceWorkflow', workflowId: 'attacker', sponsorSub: 'alice' },
      }).success,
    ).toBe(false);
  });
  test.each(['scopes', 'userId', 'agentIdentity', 'authority', 'privilege'])(
    'rejects authority field %s in task input',
    (key) => {
      const spec = scheduleFixture();
      spec.task.input = { [key]: 'admin' };
      expect(scheduleSpecSchema.safeParse(spec).success).toBe(false);
    },
  );
  test.each(['skill', 'sources', 'budget', 'deadline'])(
    'task cannot exceed its %s ceiling',
    (kind) => {
      const spec = scheduleFixture();
      if (kind === 'skill') spec.task.skillId = 'other';
      if (kind === 'sources') spec.task.sourceAllowlist = ['secret'];
      if (kind === 'budget') spec.task.executionPolicy.budgetUsd = 2;
      if (kind === 'deadline') spec.task.executionPolicy.deadlineSeconds = 301;
      expect(scheduleSpecSchema.safeParse(spec).success).toBe(false);
    },
  );
  test('duplicate privilege labels and weekdays are rejected', () => {
    const spec = scheduleFixture();
    spec.maxPrivilege.scopes = ['ticket.create', 'ticket.create'];
    expect(scheduleSpecSchema.safeParse(spec).success).toBe(false);
    spec.maxPrivilege.scopes = ['ticket.create'];
    spec.allowedWindow.weekdays = [1, 1];
    expect(scheduleSpecSchema.safeParse(spec).success).toBe(false);
  });
  test('record schema rejects an invalid revision or state', () => {
    const spec = scheduleFixture();
    const row = {
      spec,
      digest: scheduleHash(spec),
      state: 'active',
      revision: 1,
      createdAt: spec.timing.kind === 'interval' ? spec.timing.anchor : '',
      updatedAt: '2026-10-14T10:00:00.000Z',
      cursor: '2026-10-14T10:00:00.000Z',
    };
    expect(scheduleRecordSchema.safeParse(row).success).toBe(true);
    expect(scheduleRecordSchema.safeParse({ ...row, revision: 0 }).success).toBe(false);
    expect(scheduleRecordSchema.safeParse({ ...row, state: 'running' }).success).toBe(false);
  });
  test('ceiling subset covers every authority dimension', () => {
    const p = scheduleFixture().maxPrivilege;
    expect(privilegeWithin(p, p)).toBe(true);
    const narrower = {
      ...p,
      scopes: [],
      sources: [],
      regions: [],
      classification: 'PUBLIC' as const,
      budgetUsd: 0,
      deadlineSeconds: 1,
    };
    expect(privilegeWithin(narrower, p)).toBe(true);
    for (const field of ['scopes', 'sources', 'regions'] as const)
      expect(privilegeWithin({ ...p, [field]: ['secret'] }, p)).toBe(false);
    expect(privilegeWithin({ ...p, classification: 'RESTRICTED' }, p)).toBe(false);
    expect(privilegeWithin({ ...p, budgetUsd: 2 }, p)).toBe(false);
    expect(privilegeWithin({ ...p, deadlineSeconds: 301 }, p)).toBe(false);
    expect(privilegeWithin({ ...p, skill: { ...p.skill, version: '2' } }, p)).toBe(false);
  });
});
