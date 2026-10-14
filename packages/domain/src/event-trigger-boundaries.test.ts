import { expect, test } from 'vitest';

import { validEventPayload } from './event-trigger-payload.js';
import { eventTriggerHash, eventTriggerSchema, receivedEventSchema } from './event-trigger.js';
import { eventTriggerFixture, scheduleFixture } from './schedule-fixtures.js';
import { scheduleHash, scheduleSpecSchema, privilegeWithin } from './schedule.js';

function schema() {
  return eventTriggerFixture(scheduleFixture().id).payloadSchema;
}

test.each([null, [], 'text', 3, true, { incidentId: null }, { incidentId: [] }])(
  'payload shape %# is rejected without coercion',
  (payload) => {
    expect(validEventPayload(schema(), payload)).toBe(false);
  },
);

test.each([0, 1, 99, 100, 101])('string length %s enforces the declared bound', (length) => {
  expect(validEventPayload(schema(), { incidentId: 'x'.repeat(length) })).toBe(length <= 100);
});

test('optional fields are optional but values still require the declared type', () => {
  const contract = schema();
  contract.properties = {
    title: { type: 'string', required: false, maxLength: 4 },
    count: { type: 'number', required: false },
    urgent: { type: 'boolean', required: false },
  };
  expect(validEventPayload(contract, {})).toBe(true);
  expect(validEventPayload(contract, { title: 'four', count: 0, urgent: false })).toBe(true);
  expect(validEventPayload(contract, { title: 'longer' })).toBe(false);
  expect(validEventPayload(contract, { count: '0' })).toBe(false);
  expect(validEventPayload(contract, { urgent: 1 })).toBe(false);
  expect(validEventPayload(contract, { extra: 'ignored?' })).toBe(false);
});

test.each([Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY])(
  'non-finite number %# cannot become canonical event evidence',
  (count) => {
    const contract = schema();
    contract.properties = { count: { type: 'number', required: true } };
    expect(validEventPayload(contract, { count })).toBe(false);
  },
);

test('prototype-looking JSON keys cannot bypass additionalProperties false', () => {
  const payload: unknown = JSON.parse('{"incidentId":"inc-1","__proto__":{"admin":true}}');
  expect(validEventPayload(schema(), payload)).toBe(false);
  const constructorPayload: unknown = JSON.parse('{"incidentId":"inc-1","constructor":"admin"}');
  expect(validEventPayload(schema(), constructorPayload)).toBe(false);
});

test('multiple valid fields cannot exceed the aggregate byte limit', () => {
  const contract = schema();
  contract.properties = {
    first: { type: 'string', required: true },
    second: { type: 'string', required: true },
  };
  expect(validEventPayload(contract, { first: 'x'.repeat(8192), second: 'x'.repeat(8192) })).toBe(
    false,
  );
  expect(validEventPayload(contract, { first: 'x'.repeat(8000), second: 'x'.repeat(8000) })).toBe(
    true,
  );
});

test('cyclic operator input is rejected instead of escaping payload validation', () => {
  const payload: Record<string, unknown> = { incidentId: 'inc-1' };
  payload.self = payload;
  expect(validEventPayload(schema(), payload)).toBe(false);
});

test.each([0, 1, 3600, 3601, 1.5])('replay window %s has a bounded integer contract', (seconds) => {
  const trigger = eventTriggerFixture(scheduleFixture().id, { replayWindowSeconds: seconds });
  expect(eventTriggerSchema.safeParse(trigger).success).toBe(seconds === 1 || seconds === 3600);
});

test('trigger schema rejects schema extensions and undefined algorithms', () => {
  const trigger = eventTriggerFixture(scheduleFixture().id);
  expect(eventTriggerSchema.safeParse({ ...trigger, algorithm: 'none' }).success).toBe(false);
  expect(eventTriggerSchema.safeParse({ ...trigger, signingKeyId: '' }).success).toBe(false);
  expect(eventTriggerSchema.safeParse({ ...trigger, scopes: ['admin'] }).success).toBe(false);
  expect(
    eventTriggerSchema.safeParse({
      ...trigger,
      payloadSchema: { ...trigger.payloadSchema, additionalProperties: true },
    }).success,
  ).toBe(false);
});

test('trigger hash is insensitive to object insertion order but binds every security field', () => {
  const trigger = eventTriggerFixture(scheduleFixture().id);
  const digest = eventTriggerHash(trigger);
  expect(
    eventTriggerHash({
      ...trigger,
      payloadSchema: {
        properties: trigger.payloadSchema.properties,
        additionalProperties: false,
        type: 'object',
      },
    }),
  ).toBe(digest);
  expect(eventTriggerHash({ ...trigger, signingKeyId: 'key-2' })).not.toBe(digest);
  expect(eventTriggerHash({ ...trigger, source: 'other' })).not.toBe(digest);
  expect(eventTriggerHash({ ...trigger, replayWindowSeconds: 60 })).not.toBe(digest);
});

test('received evidence cannot be relabelled trusted', () => {
  const trigger = eventTriggerFixture(scheduleFixture().id);
  const event = {
    key: 'a'.repeat(64),
    triggerId: trigger.id,
    scheduleId: trigger.scheduleId,
    source: trigger.source,
    eventId: 'one',
    timestamp: '2026-10-14T10:00:00.000Z',
    receivedAt: '2026-10-14T10:00:00.000Z',
    digest: 'b'.repeat(64),
    trust: 'trusted',
    payload: { incidentId: 'inc-1' },
    runId: 'c'.repeat(64),
  };
  expect(receivedEventSchema.safeParse(event).success).toBe(false);
  expect(receivedEventSchema.safeParse({ ...event, trust: 'untrusted' }).success).toBe(true);
});

test('canonical schedule hash binds the revocation, window, consent and pinned authority', () => {
  const spec = scheduleFixture();
  const digest = scheduleHash(spec);
  expect(scheduleHash({ ...spec, consentRef: 'consent-2' })).not.toBe(digest);
  expect(scheduleHash({ ...spec, timezone: 'Asia/Tokyo' })).not.toBe(digest);
  expect(scheduleHash({ ...spec, misfire: 'skip' })).not.toBe(digest);
  expect(
    scheduleHash({ ...spec, allowedWindow: { ...spec.allowedWindow, start: '09:00' } }),
  ).not.toBe(digest);
  expect(
    scheduleHash({ ...spec, maxPrivilege: { ...spec.maxPrivilege, classification: 'PUBLIC' } }),
  ).not.toBe(digest);
});

test.each([
  ['PUBLIC', 'INTERNAL', true],
  ['INTERNAL', 'PUBLIC', false],
  ['RESTRICTED', 'CONFIDENTIAL', false],
  ['CONFIDENTIAL', 'RESTRICTED', true],
] as const)('%s ceiling within %s authority is %s', (ceiling, authority, allowed) => {
  const privilege = scheduleFixture().maxPrivilege;
  expect(
    privilegeWithin(
      { ...privilege, classification: ceiling },
      { ...privilege, classification: authority },
    ),
  ).toBe(allowed);
});

test.each([0, 59, 60, 31536000, 31536001, 60.5])(
  'interval %s follows the bounded timing schema',
  (everySeconds) => {
    const spec = scheduleFixture({
      timing: { kind: 'interval', everySeconds, anchor: '2026-10-14T10:00:00.000Z' },
    });
    expect(scheduleSpecSchema.safeParse(spec).success).toBe(
      Number.isInteger(everySeconds) && everySeconds >= 60 && everySeconds <= 31536000,
    );
  },
);
