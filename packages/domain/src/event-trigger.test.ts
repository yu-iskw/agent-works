import { expect, test } from 'vitest';

import { validEventPayload } from './event-trigger-payload.js';
import {
  eventTriggerSchema,
  eventTriggerHash,
  sourceEventKey,
  receivedEventSchema,
} from './event-trigger.js';
import { scheduleFixture, eventTriggerFixture } from './schedule-fixtures.js';
test('strict pinned event trigger hashes signing and schema fields', () => {
  const value = eventTriggerFixture(scheduleFixture().id);
  expect(eventTriggerSchema.parse(value)).toEqual(value);
  expect(eventTriggerHash(value)).toHaveLength(64);
  expect(eventTriggerHash({ ...value, signingKeyId: 'key-2' })).not.toBe(eventTriggerHash(value));
});
test('source ID dedupe key is unambiguous', () => {
  expect(sourceEventKey('a:b', 'c')).not.toBe(sourceEventKey('a', 'b:c'));
  expect(sourceEventKey('a', '1')).not.toBe(sourceEventKey('b', '1'));
});
test.each([0, 3601, -1, 1.5])('rejects replay window %s', (replayWindowSeconds) => {
  expect(
    eventTriggerSchema.safeParse(eventTriggerFixture(scheduleFixture().id, { replayWindowSeconds }))
      .success,
  ).toBe(false);
});
test.each([
  null,
  [],
  {},
  { incidentId: 12 },
  { incidentId: 'a', scopes: ['admin'] },
  { incidentId: 'a', authority: 'admin' },
  { incidentId: 'a'.repeat(101) },
])('payload schema rejects invalid body %#', (payload) => {
  expect(validEventPayload(eventTriggerFixture(scheduleFixture().id).payloadSchema, payload)).toBe(
    false,
  );
});
test('valid body is accepted without coercion', () => {
  expect(
    validEventPayload(eventTriggerFixture(scheduleFixture().id).payloadSchema, {
      incidentId: 'inc-1',
    }),
  ).toBe(true);
});
test('optional field may be absent and number/boolean types stay exact', () => {
  const schema = {
    type: 'object' as const,
    additionalProperties: false as const,
    properties: {
      count: { type: 'number' as const, required: true },
      enabled: { type: 'boolean' as const, required: true },
      note: { type: 'string' as const, required: false },
    },
  };
  expect(validEventPayload(schema, { count: 0, enabled: false })).toBe(true);
  expect(validEventPayload(schema, { count: '0', enabled: false })).toBe(false);
  expect(validEventPayload(schema, { count: 0, enabled: 'false' })).toBe(false);
});
test('schema never permits arbitrary additional properties', () => {
  const trigger = eventTriggerFixture(scheduleFixture().id);
  expect(
    eventTriggerSchema.safeParse({
      ...trigger,
      payloadSchema: { ...trigger.payloadSchema, additionalProperties: true },
    }).success,
  ).toBe(false);
});
test('a received event cannot be relabeled trusted', () => {
  expect(receivedEventSchema.safeParse({ trust: 'trusted' }).success).toBe(false);
});
