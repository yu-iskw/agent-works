import { randomUUID } from 'node:crypto';

import { describe, expect, test } from 'vitest';
import * as z from 'zod';

import { canonicalPayloadSha256 } from './canonical-hash.js';
import {
  createEnvelopeReader,
  type DispatchEnvelopeV1,
  dispatchEnvelopeV1Schema,
  dispatchTransportName,
  maxDispatchEnvelopeBytes,
  occurrenceExecutionId,
  occurrenceRecordSchema,
  outboxRecordSchema,
  readDispatchEnvelope,
  serializeDispatchEnvelope,
} from './dispatch-envelope.js';
import { scheduleRunId } from './schedule-run.js';

const executionId = 'a'.repeat(64);
const goldenV1 = `{"schemaVersion":1,"executionId":"${executionId}","dispatchId":"d-0001","correlationId":"corr-1"}`;
const v1 = {
  schemaVersion: 1 as const,
  executionId,
  dispatchId: 'd-0001',
  correlationId: 'corr-1',
};
const v2Schema = z.strictObject({
  schemaVersion: z.literal(2),
  executionId: z.string(),
  dispatchId: z.string(),
  priority: z.number().int(),
});
const slot = '2026-10-14T10:01:00.000Z';

describe('versioned queue envelope', () => {
  test('serialization fixture is byte-stable and round-trips', () => {
    expect(serializeDispatchEnvelope(v1)).toBe(goldenV1);
    expect(readDispatchEnvelope(goldenV1)).toEqual({ ok: true, envelope: v1 });
    expect(readDispatchEnvelope(Buffer.from(goldenV1))).toEqual({ ok: true, envelope: v1 });
    expect(serializeDispatchEnvelope({ ...v1, correlationId: undefined })).toBe(
      `{"schemaVersion":1,"executionId":"${executionId}","dispatchId":"d-0001"}`,
    );
  });

  test('unknown newer version is deferred as retryable and never partially parsed', () => {
    const body = JSON.stringify({ schemaVersion: 2, executionId, dispatchId: 'd', priority: 1 });
    expect(readDispatchEnvelope(body)).toEqual({
      ok: false,
      reason: 'unsupported-version',
      retryable: true,
    });
  });

  test.each([
    ['version zero', { ...v1, schemaVersion: 0 }],
    ['fractional version', { ...v1, schemaVersion: 1.5 }],
    ['string version', { ...v1, schemaVersion: '1' }],
    ['missing version', { executionId, dispatchId: 'd' }],
    ['array body', [v1]],
    ['unknown field', { ...v1, prompt: 'summarize the board minutes' }],
    ['bearer token field', { ...v1, authorization: 'Bearer abc' }],
    ['non-opaque id', { ...v1, executionId: 'has space' }],
    ['empty dispatch id', { ...v1, dispatchId: '' }],
  ])('permanently rejects %s so transport stops retrying', (_name, value) => {
    expect(readDispatchEnvelope(JSON.stringify(value))).toMatchObject({
      ok: false,
      retryable: false,
    });
  });

  test('rejects malformed JSON and oversize bodies', () => {
    expect(readDispatchEnvelope('{')).toEqual({ ok: false, reason: 'malformed', retryable: false });
    const big = JSON.stringify({ ...v1, correlationId: 'c'.repeat(maxDispatchEnvelopeBytes) });
    expect(readDispatchEnvelope(big)).toEqual({ ok: false, reason: 'too-large', retryable: false });
    expect(() => serializeDispatchEnvelope({ ...v1, correlationId: 'c'.repeat(129) })).toThrow();
  });

  test('new reader accepts old messages and old reader defers new ones (rolling update)', () => {
    const newReader = createEnvelopeReader<z.infer<typeof v2Schema> | DispatchEnvelopeV1>({
      1: dispatchEnvelopeV1Schema,
      2: v2Schema,
    });
    const v2Body = JSON.stringify({
      schemaVersion: 2,
      executionId,
      dispatchId: 'd-2',
      priority: 3,
    });
    expect(newReader(goldenV1)).toEqual({ ok: true, envelope: v1 });
    expect(newReader(v2Body)).toMatchObject({ ok: true, envelope: { priority: 3 } });
    expect(readDispatchEnvelope(v2Body)).toMatchObject({ ok: false, retryable: true });
    expect(newReader(JSON.stringify({ ...v1, schemaVersion: 3 }))).toMatchObject({
      ok: false,
      retryable: true,
    });
  });
});

describe('canonical occurrence identity and edits', () => {
  const scheduleId = randomUUID();

  test('execution id is the existing scheduleRunId and ignores revision', () => {
    const identity = { scheduleId, fireAt: slot, eventKey: null };
    expect(occurrenceExecutionId(identity)).toBe(scheduleRunId(scheduleId, slot));
    const at = (definitionRevision: number) =>
      occurrenceRecordSchema.parse({
        executionId: occurrenceExecutionId(identity),
        identity,
        definitionRevision,
        definitionDigest: 'b'.repeat(64),
      });
    expect(at(1).executionId).toBe(at(7).executionId);
  });

  test('a revision-keyed hash would fork the slot, which is why it is rejected', () => {
    const keyed = (revision: number) => canonicalPayloadSha256({ scheduleId, revision, slot });
    expect(keyed(1)).not.toBe(keyed(2));
  });

  test('identity schema rejects a revision field and non-canonical slots', () => {
    const base = { scheduleId, fireAt: slot, eventKey: null };
    expect(() => occurrenceExecutionId({ ...base, revision: 2 } as typeof base)).toThrow();
    expect(() => occurrenceExecutionId({ ...base, fireAt: '2026-10-14T10:01:00Z' })).toThrow();
    expect(() =>
      occurrenceExecutionId({ ...base, fireAt: '2026-10-14T19:01:00.000+09:00' }),
    ).toThrow();
  });

  test('event keys form a separate identity domain', () => {
    const timed = occurrenceExecutionId({ scheduleId, fireAt: slot, eventKey: null });
    const event = occurrenceExecutionId({ scheduleId, fireAt: slot, eventKey: 'c'.repeat(64) });
    expect(event).not.toBe(timed);
  });

  test('a record whose key was derived with anything else is rejected', () => {
    expect(() =>
      occurrenceRecordSchema.parse({
        executionId: 'd'.repeat(64),
        identity: { scheduleId, fireAt: slot, eventKey: null },
        definitionRevision: 1,
        definitionDigest: 'b'.repeat(64),
      }),
    ).toThrow();
  });
});

describe('outbox record', () => {
  const outbox = (over: Record<string, unknown> = {}) => ({
    dispatchId: 'd-0001',
    executionId,
    targetKind: 'cloud-tasks-http',
    transportName: dispatchTransportName('d-0001'),
    envelope: v1,
    state: 'pending',
    attempts: 0,
    nextAttemptAt: slot,
    leaseOwner: null,
    leaseUntil: null,
    lastErrorClass: null,
    createdAt: slot,
    publishedAt: null,
    ...over,
  });

  test('accepts a pending row and a published row', () => {
    expect(outboxRecordSchema.parse(outbox())).toMatchObject({ state: 'pending' });
    expect(
      outboxRecordSchema.parse(outbox({ state: 'published', publishedAt: slot, attempts: 2 })),
    ).toMatchObject({ state: 'published' });
  });

  test.each([
    ['envelope for another dispatch', { envelope: { ...v1, dispatchId: 'other' } }],
    ['transport name not derived from id', { transportName: `d-${'0'.repeat(64)}` }],
    ['lease owner without expiry', { leaseOwner: 'pub-1' }],
    ['published without timestamp', { state: 'published' }],
    ['timestamp while pending', { publishedAt: slot }],
    ['unknown target', { targetKind: 'pubsub' }],
    ['unknown field', { payload: 'prompt text' }],
  ])('rejects %s', (_name, over) => {
    expect(() => outboxRecordSchema.parse(outbox(over))).toThrow();
  });

  test('transport name is deterministic and charset-safe', () => {
    expect(dispatchTransportName('d-0001')).toBe(dispatchTransportName('d-0001'));
    expect(dispatchTransportName('d-0001')).not.toBe(dispatchTransportName('d-0002'));
    expect(dispatchTransportName('x:y')).toMatch(/^d-[a-f0-9]{64}$/);
  });
});
