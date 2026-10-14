import { describe, expect, test } from 'vitest';

import { suspensionDecision, suspensionFacts } from './suspension.js';

import type { InvocationContext } from './suspension.js';
import type { CapabilityPin, CapabilityVersion, Suspension } from '@agent-works/domain';

const context: InvocationContext = {
  subject: 'alice',
  teams: ['engineering'],
  agent: { kind: 'agent', id: 'api', version: '1' },
  skill: { kind: 'skill', id: 'incident', version: '1' },
  model: 'gemini',
  tool: { kind: 'tool', id: 'ticket.create', version: '1' },
  taskId: 'task',
  traceId: 'trace',
};
const pins = [context.agent, context.skill, context.tool as CapabilityPin];
const versions: CapabilityVersion[] = pins.map((pin) => ({
  pin,
  state: 'published',
  reason: 'release',
  actorSub: 'admin',
  revision: 1,
  occurredAt: '2026-10-14T10:00:00.000Z',
  commandId: '00000000-0000-4000-8000-000000000001',
}));
const at = new Date('2026-10-14T10:00:00.000Z');
const clear = {
  storeReachable: true,
  contextComplete: true,
  suspended: false,
  versionsPublished: true,
  revoked: false,
};
describe('suspension policy facts', () => {
  test('all explicit safe facts permit and omitted facts deny', () => {
    expect(suspensionDecision(clear)).toBeUndefined();
    expect(suspensionDecision({})).toBe('SUSPENSION_STORE_UNAVAILABLE');
    for (const key of Object.keys(clear)) {
      const partial = { ...clear };
      Reflect.deleteProperty(partial, key);
      expect(suspensionDecision(partial)).toBeDefined();
    }
  });
  test.each([
    { scope: 'global', id: '*', version: null },
    { scope: 'user', id: 'alice', version: null },
    { scope: 'team', id: 'engineering', version: null },
    { scope: 'agent', id: 'api', version: '1' },
    { scope: 'skill', id: 'incident', version: '1' },
    { scope: 'tool', id: 'ticket.create', version: '1' },
    { scope: 'model', id: 'gemini', version: null },
  ] as const)('$scope produces a deny fact', (target) => {
    const value: Suspension = {
      target,
      suspended: true,
      reason: 'stop',
      actorSub: 'operator',
      revision: 1,
      occurredAt: at.toISOString(),
      expiresAt: null,
      commandId: '00000000-0000-4000-8000-000000000001',
    };
    expect(suspensionDecision(suspensionFacts(context, [value], versions, at))).toBe(
      'INVOCATION_SUSPENDED',
    );
    expect(suspensionFacts(context, [{ ...value, suspended: false }], versions, at).suspended).toBe(
      false,
    );
  });
  test('unrelated subjects, teams, versions and models are unaffected', () => {
    for (const target of [
      { scope: 'user', id: 'bob', version: null },
      { scope: 'team', id: 'sales', version: null },
      { scope: 'skill', id: 'incident', version: '2' },
      { scope: 'model', id: 'other', version: null },
    ] as const) {
      const value: Suspension = {
        target,
        suspended: true,
        reason: 'stop',
        actorSub: 'operator',
        revision: 1,
        occurredAt: at.toISOString(),
        expiresAt: null,
        commandId: '00000000-0000-4000-8000-000000000001',
      };
      expect(suspensionDecision(suspensionFacts(context, [value], versions, at))).toBeUndefined();
    }
  });
  test('deprecated pinned versions continue but draft, absent and revoked do not', () => {
    expect(
      suspensionDecision(
        suspensionFacts(
          context,
          [],
          versions.map((value) => ({ ...value, state: 'deprecated' })),
          at,
        ),
      ),
    ).toBeUndefined();
    expect(suspensionDecision(suspensionFacts(context, [], [], at))).toBe(
      'CAPABILITY_VERSION_UNPUBLISHED',
    );
    expect(
      suspensionDecision(
        suspensionFacts(
          context,
          [],
          versions.map((value) => ({ ...value, state: 'revoked' })),
          at,
        ),
      ),
    ).toBe('CAPABILITY_VERSION_REVOKED');
  });
});
