import { describe, expect, test } from 'vitest';

import {
  suspensionActive,
  suspensionCommandSchema,
  suspensionHash,
  suspensionKey,
  suspensionSchema,
  suspensionScopes,
  suspensionTargetSchema,
} from './suspension.js';

const at = '2026-10-14T10:00:00.000Z';
const target = { scope: 'global' as const, id: '*' as const, version: null };
const record = {
  target,
  suspended: true,
  reason: 'Operator stop',
  actorSub: 'admin',
  expiresAt: null,
  revision: 1,
  occurredAt: at,
  commandId: '00000000-0000-4000-8000-000000000001',
};
describe('suspension schema contract', () => {
  test.each(suspensionScopes)('accepts %s scope', (scope) => {
    expect(
      suspensionTargetSchema.parse({
        scope,
        id: scope === 'global' ? '*' : 'target',
        version: null,
      }).scope,
    ).toBe(scope);
  });
  test.each(['global', 'team', 'user', 'model'] as const)('rejects a version on %s', (scope) => {
    expect(
      suspensionTargetSchema.safeParse({
        scope,
        id: scope === 'global' ? '*' : 'target',
        version: '1',
      }).success,
    ).toBe(false);
  });
  test.each(['agent', 'skill', 'tool'] as const)('accepts immutable version pin on %s', (scope) => {
    expect(suspensionTargetSchema.parse({ scope, id: 'capability', version: '1' }).version).toBe(
      '1',
    );
  });
  test('global target is canonical and has no client role or actor input', () => {
    expect(suspensionTargetSchema.safeParse({ ...target, id: 'all' }).success).toBe(false);
    expect(
      suspensionCommandSchema.safeParse({
        commandId: record.commandId,
        action: 'suspend',
        target,
        reason: 'Stop',
        expiresAt: null,
        expectedRevision: 0,
        role: 'Admin',
      }).success,
    ).toBe(false);
  });
  test('hash is order-independent and covers every persisted field', () => {
    const parsed = suspensionSchema.parse(record);
    expect(suspensionHash(parsed)).toBe(
      suspensionHash({ ...parsed, target: { version: null, id: '*', scope: 'global' } }),
    );
    for (const changed of [
      { ...parsed, reason: 'Different' },
      { ...parsed, actorSub: 'other' },
      { ...parsed, suspended: false },
      { ...parsed, revision: 2 },
    ])
      expect(suspensionHash(changed)).not.toBe(suspensionHash(parsed));
    expect(suspensionKey(target)).toMatch(/^[a-f0-9]{64}$/);
  });
  test('expiry and resume semantics have a precise boundary', () => {
    const expiresAt = '2026-10-14T10:00:01.000Z';
    expect(suspensionActive({ ...record, expiresAt }, new Date(at))).toBe(true);
    expect(suspensionActive({ ...record, expiresAt }, new Date(expiresAt))).toBe(false);
    expect(suspensionActive({ ...record, suspended: false }, new Date(at))).toBe(false);
  });
  test.each(['', ' ', 'x'.repeat(2001)])('rejects invalid reason length', (reason) => {
    expect(
      suspensionCommandSchema.safeParse({
        commandId: record.commandId,
        action: 'suspend',
        target,
        reason,
        expiresAt: null,
        expectedRevision: 0,
      }).success,
    ).toBe(false);
  });
  test.each([-1, 0.5, Number.NaN])('rejects invalid expected revision %s', (expectedRevision) => {
    expect(
      suspensionCommandSchema.safeParse({
        commandId: record.commandId,
        action: 'suspend',
        target,
        reason: 'Stop',
        expiresAt: null,
        expectedRevision,
      }).success,
    ).toBe(false);
  });
});
