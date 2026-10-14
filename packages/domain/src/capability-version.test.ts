import { expect, test } from 'vitest';

import {
  capabilityKey,
  capabilityPinSchema,
  capabilityTransition,
  capabilityVersionHash,
  capabilityVersionSchema,
} from './capability-version.js';

const states = ['draft', 'published', 'deprecated', 'revoked'] as const;
test.each(states.flatMap((from) => states.map((to) => ({ from, to }))))(
  '$from → $to lifecycle',
  ({ from, to }) => {
    const allowed = new Set([
      'draft:published',
      'draft:revoked',
      'published:deprecated',
      'published:revoked',
      'deprecated:revoked',
    ]);
    expect(capabilityTransition(from, to)).toBe(allowed.has(`${from}:${to}`));
  },
);
test.each(states)('initial %s lifecycle state', (state) => {
  expect(capabilityTransition(undefined, state)).toBe(state === 'draft');
});
test('pin and record canonical hashes isolate versions', () => {
  const pin = capabilityPinSchema.parse({ kind: 'skill', id: 'incident', version: '1' });
  expect(capabilityKey(pin)).not.toBe(capabilityKey({ ...pin, version: '2' }));
  const value = capabilityVersionSchema.parse({
    pin,
    state: 'published',
    reason: 'Release',
    actorSub: 'operator',
    revision: 2,
    occurredAt: '2026-10-14T10:00:00.000Z',
    commandId: '00000000-0000-4000-8000-000000000001',
  });
  expect(capabilityVersionHash(value)).not.toBe(
    capabilityVersionHash({ ...value, state: 'revoked' }),
  );
});
test.each(['', ' ', 'x'.repeat(257)])('rejects malformed version labels', (version) => {
  expect(
    capabilityPinSchema.safeParse({ kind: 'tool', id: 'ticket.create', version }).success,
  ).toBe(false);
});
