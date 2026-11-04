import * as z from 'zod';

import { canonicalPayloadSha256 } from './canonical-hash.js';
import { scheduleRunId } from './schedule-run.js';

/** Largest serialized envelope a producer may enqueue and a consumer will parse. */
export const maxDispatchEnvelopeBytes = 512;

const opaqueId = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/);
const utcInstant = z.iso.datetime().refine((v) => new Date(v).toISOString() === v, {
  message: 'canonical UTC instant with milliseconds required',
});

/** Queue payload v1. References only: no prompts, tokens, actor claims or authority snapshots. */
export const dispatchEnvelopeV1Schema = z.strictObject({
  schemaVersion: z.literal(1),
  executionId: opaqueId,
  dispatchId: opaqueId,
  correlationId: opaqueId.optional(),
});
export type DispatchEnvelopeV1 = z.infer<typeof dispatchEnvelopeV1Schema>;

export type EnvelopeRead<T> =
  | { readonly ok: true; readonly envelope: T }
  | {
      readonly ok: false;
      /** `unsupported-version` is retryable so a newer worker revision can take the delivery. */
      readonly reason: 'too-large' | 'malformed' | 'invalid' | 'unsupported-version';
      readonly retryable: boolean;
    };

const fail = (
  reason: 'too-large' | 'malformed' | 'invalid' | 'unsupported-version',
  retryable = false,
): { readonly ok: false; readonly reason: typeof reason; readonly retryable: boolean } => ({
  ok: false,
  reason,
  retryable,
});

function parseBody(
  body: string | Uint8Array,
): { json: unknown } | { error: 'too-large' | 'malformed' } {
  const bytes = typeof body === 'string' ? Buffer.byteLength(body, 'utf8') : body.byteLength;
  if (bytes > maxDispatchEnvelopeBytes) return { error: 'too-large' };
  try {
    return {
      json: JSON.parse(typeof body === 'string' ? body : Buffer.from(body).toString('utf8')),
    };
  } catch {
    return { error: 'malformed' };
  }
}

function versionOf(json: unknown): number | undefined {
  if (typeof json !== 'object' || json === null || Array.isArray(json)) return undefined;
  const version = (json as { schemaVersion?: unknown }).schemaVersion;
  return typeof version === 'number' && Number.isInteger(version) && version >= 1
    ? version
    : undefined;
}

/** Consumer for a closed set of supported versions. A version above the newest is deferred. */
export function createEnvelopeReader<T>(
  schemas: Readonly<Record<number, z.ZodType<T>>>,
): (body: string | Uint8Array) => EnvelopeRead<T> {
  const newest = Math.max(...Object.keys(schemas).map(Number));
  return (body) => {
    const parsedBody = parseBody(body);
    if ('error' in parsedBody) return fail(parsedBody.error);
    const version = versionOf(parsedBody.json);
    if (version === undefined) return fail('invalid');
    if (version > newest) return fail('unsupported-version', true);
    const schema = new Map(Object.entries(schemas)).get(String(version));
    if (schema === undefined) return fail('unsupported-version');
    const parsed = schema.safeParse(parsedBody.json);
    return parsed.success ? { ok: true, envelope: parsed.data } : fail('invalid');
  };
}

export const readDispatchEnvelope = createEnvelopeReader<DispatchEnvelopeV1>({
  1: dispatchEnvelopeV1Schema,
});

/** Fixed key order so equal envelopes serialize to equal bytes. */
export function serializeDispatchEnvelope(value: DispatchEnvelopeV1): string {
  const e = dispatchEnvelopeV1Schema.parse(value);
  const body = JSON.stringify({
    schemaVersion: e.schemaVersion,
    executionId: e.executionId,
    dispatchId: e.dispatchId,
    ...(e.correlationId === undefined ? {} : { correlationId: e.correlationId }),
  });
  if (Buffer.byteLength(body, 'utf8') > maxDispatchEnvelopeBytes)
    throw new RangeError('dispatch envelope too large');
  return body;
}

/**
 * Canonical occurrence identity. It is the pre-existing `scheduleRunId` domain: schedule id,
 * UTC slot, and the source-event key for event runs only. There is deliberately no revision
 * field, and the strict object rejects one.
 */
const occurrenceIdentitySchema = z.strictObject({
  scheduleId: z.uuid(),
  fireAt: utcInstant,
  eventKey: z
    .string()
    .regex(/^[a-f0-9]{64}$/)
    .nullable(),
});
export type OccurrenceIdentity = z.infer<typeof occurrenceIdentitySchema>;

export function occurrenceExecutionId(identity: OccurrenceIdentity): string {
  const i = occurrenceIdentitySchema.parse(identity);
  return scheduleRunId(i.scheduleId, i.fireAt, i.eventKey);
}

/** Occurrence row shape: identity-derived key plus the definition revision that produced it. */
export const occurrenceRecordSchema = z
  .strictObject({
    executionId: z.string().regex(/^[a-f0-9]{64}$/),
    identity: occurrenceIdentitySchema,
    definitionRevision: z.number().int().positive(),
    definitionDigest: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .refine((v) => v.executionId === occurrenceExecutionId(v.identity), {
    message: 'executionId must derive from identity alone',
  });
export type OccurrenceRecord = z.infer<typeof occurrenceRecordSchema>;

/** Deterministic Cloud Tasks name: stable across publish retries, valid charset, no raw ids. */
export function dispatchTransportName(dispatchId: string): string {
  return `d-${canonicalPayloadSha256({ dispatchId })}`;
}

/** Outbox row written in the claim transaction; the publisher claims it outside any claim lock. */
export const outboxRecordSchema = z
  .strictObject({
    dispatchId: opaqueId,
    executionId: opaqueId,
    targetKind: z.enum(['cloud-tasks-http']),
    transportName: z.string().regex(/^d-[a-f0-9]{64}$/),
    envelope: dispatchEnvelopeV1Schema,
    state: z.enum(['pending', 'published', 'abandoned']),
    attempts: z.number().int().nonnegative(),
    nextAttemptAt: utcInstant,
    leaseOwner: z.string().min(1).nullable(),
    leaseUntil: utcInstant.nullable(),
    lastErrorClass: z.string().min(1).max(64).nullable(),
    createdAt: utcInstant,
    publishedAt: utcInstant.nullable(),
  })
  .superRefine((v, ctx) => {
    const fail = (message: string) => ctx.addIssue({ code: 'custom', message });
    if (v.envelope.dispatchId !== v.dispatchId || v.envelope.executionId !== v.executionId)
      fail('envelope must match outbox identity');
    if (v.transportName !== dispatchTransportName(v.dispatchId))
      fail('transport name must derive from dispatchId');
    if ((v.leaseOwner === null) !== (v.leaseUntil === null))
      fail('lease owner and expiry travel together');
    if ((v.state === 'published') !== (v.publishedAt !== null))
      fail('publishedAt is set exactly when published');
  });
export type OutboxRecord = z.infer<typeof outboxRecordSchema>;
