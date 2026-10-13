import { z } from 'zod';

import { canonicalPayloadSha256 } from '../../../packages/domain/src/canonical-hash.ts';
import { verifyTranscriptBytes } from '../../common/verify.mjs';

import { matrix, matrixId, query } from './matrix.ts';
import { summarizeRevocation } from './revocation.ts';

const label = z.string().trim().min(1).max(500);
const timestamp = z.iso.datetime();
const measurement = z.number().finite().nonnegative().nullable();
export const hitSchema = z.strictObject({
  sourceObjectId: label,
  title: z.string().max(10000),
  snippet: z.string().max(10000),
  content: z.string().max(1_000_000),
  provenance: z
    .strictObject({
      sourceUri: z.url().regex(/^https:\/\/(?:drive\.google\.com|docs\.google\.com)\//),
      version: label,
      retrievedAt: timestamp,
      accessDecisionId: label,
      subject: z.enum(['alice', 'bob', 'reviewer', 'outsider']),
      sourceAccessChecked: z.boolean(),
    })
    .nullable(),
});
export const caseSchema = z.strictObject({
  id: z.enum(matrix.map((entry) => entry.id)),
  subject: z.enum(['alice', 'bob', 'reviewer', 'outsider']),
  query: z.literal(query),
  status: z.enum(['ok', 'permission-denied', 'unavailable']),
  httpStatus: z.number().int().min(100).max(599).nullable(),
  /** Additional returned surfaces, including answer text and error bodies; do not hide them. */
  responseText: z.string().max(1_000_000),
  hits: z.array(hitSchema).max(100),
  latencyMs: measurement,
  changedAt: timestamp.nullable(),
  checkedAt: timestamp.nullable(),
  /** Null until repeated polling demonstrates denial and subsequent checks stay denied. */
  revocationLagMs: measurement,
  revocationChecks: z
    .array(z.strictObject({ checkedAt: timestamp, denied: z.boolean(), sourceObjectId: label }))
    .max(120)
    .default([]),
});
export const evidenceShapeSchema = z.strictObject({
  schemaId: z.literal('agent-works.retrieval.evidence'),
  schemaVersion: z.literal(1),
  matrixId: z.literal(matrixId),
  arm: z.enum(['A', 'B']),
  service: z.enum(['gemini-enterprise', 'drive-delegated']),
  provenance: z.enum(['synthetic', 'observed']),
  verdict: z.enum(['UNVERIFIED', 'DEFER', 'GO', 'NO-GO']),
  availability: z.enum(['available', 'unavailable', 'not-probed']),
  capturedAt: timestamp,
  featureScope: label,
  region: z.literal('asia-northeast1'),
  /** Operators attest exact source/connector ACL and identity-mapping configuration. */
  configuration: z.strictObject({
    sourceAclMode: label,
    identityMapping: label,
    featureStage: label,
  }),
  reason: label,
  costUsd: measurement,
  cases: z.array(caseSchema).max(6),
  omitted: z.array(label),
});
type EvidenceShape = z.infer<typeof evidenceShapeSchema>;

function caseErrors(entry: z.infer<typeof caseSchema>, capturedAt: string): string[] {
  const errors: string[] = [];
  const expected = matrix.find((item) => item.id === entry.id);
  if (entry.subject !== expected?.subject) errors.push('matrix identity mismatch');
  if (entry.status !== 'ok' && entry.hits.length > 0)
    errors.push('denied/unavailable response has hits');
  if (!validTiming(entry)) errors.push('revocation timing not supported by timestamps');
  if (entry.checkedAt && Date.parse(entry.checkedAt) > Date.parse(capturedAt))
    errors.push('case captured after evidence capture');
  return errors;
}

function validTiming(entry: z.infer<typeof caseSchema>): boolean {
  if (entry.revocationLagMs === null) return true;
  if (!entry.changedAt || !entry.checkedAt) return false;
  const elapsed = Date.parse(entry.checkedAt) - Date.parse(entry.changedAt);
  if (elapsed < 0 || entry.revocationLagMs > elapsed) return false;
  const target = entry.id === 'revoked-member' ? 'reviewer-shared' : 'alice-private';
  if (entry.revocationChecks.some((check) => check.sourceObjectId !== target)) return false;
  try {
    const observed = summarizeRevocation(entry.changedAt, entry.revocationChecks);
    const last = entry.revocationChecks.at(-1);
    return (
      observed.stable &&
      observed.revocationLagMs === entry.revocationLagMs &&
      last?.checkedAt === entry.checkedAt
    );
  } catch {
    return false;
  }
}

function runErrors(value: EvidenceShape): string[] {
  const errors: string[] = [];
  if ((value.arm === 'A') !== (value.service === 'gemini-enterprise'))
    errors.push('arm/service mismatch');
  const ids = value.cases.map((entry) => entry.id);
  if (new Set(ids).size !== ids.length) errors.push('duplicate matrix case');
  if (value.availability === 'unavailable' && value.verdict !== 'DEFER')
    errors.push('unavailable must defer');
  if (value.verdict === 'GO' && !observedComplete(value))
    errors.push('GO requires complete observed evidence');
  if (value.provenance === 'synthetic' && hasMeasurements(value))
    errors.push('synthetic measurements prohibited');
  return errors;
}

function observedComplete(value: EvidenceShape) {
  return (
    value.provenance === 'observed' &&
    value.cases.length === matrix.length &&
    value.availability === 'available' &&
    value.configuration.sourceAclMode !== 'unverified' &&
    value.configuration.identityMapping !== 'unverified' &&
    value.configuration.featureStage !== 'operator-gated'
  );
}

function hasMeasurements(value: EvidenceShape) {
  return (
    value.costUsd !== null ||
    value.cases.some((entry) => entry.latencyMs !== null || entry.revocationLagMs !== null)
  );
}

export const evidenceSchema = evidenceShapeSchema.superRefine((value, context) => {
  const errors = [
    ...runErrors(value),
    ...value.cases.flatMap((entry) => caseErrors(entry, value.capturedAt)),
  ];
  for (const message of errors) context.addIssue({ code: 'custom', message });
});
export type RetrievalEvidence = z.infer<typeof evidenceSchema>;
export type EvidenceCase = z.infer<typeof caseSchema>;
export type EvidenceHit = z.infer<typeof hitSchema>;

export const evidenceEnvelopeSchema = z.strictObject({
  evidence: evidenceSchema,
  digest: z.string().regex(/^[a-f0-9]{64}$/),
  /** #98 envelope, required for observed runs. Its evidence-sha256 observation binds the payload. */
  transcript: z.unknown().nullable(),
});

function rejectSecrets(input: unknown) {
  const text = JSON.stringify(input);
  // Deliberately never include the matching text in an exception.
  if (
    /(?:Bearer\s+[A-Za-z0-9._~+/-]{8,}|ya29\.|ghp_[A-Za-z0-9]{8,}|sk-[A-Za-z0-9_-]{8,}|"(?:access_token|refresh_token|client_secret|private_key)"\s*:)/i.test(
      text,
    )
  ) {
    throw new Error('evidence contains prohibited credentials');
  }
}

export function sealEvidence(evidence: unknown, transcript: unknown = null) {
  rejectSecrets(evidence);
  const parsed = evidenceSchema.parse(evidence);
  const envelope = { evidence: parsed, digest: canonicalPayloadSha256(parsed), transcript };
  parseEvidence(envelope);
  return envelope;
}

export function parseEvidence(input: unknown): RetrievalEvidence {
  rejectSecrets(input);
  const raw = z.object({ evidence: z.unknown(), digest: z.string() }).parse(input);
  if (canonicalPayloadSha256(raw.evidence) !== raw.digest)
    throw new Error('evidence checksum mismatch');
  const envelope = evidenceEnvelopeSchema.parse(input);
  if (canonicalPayloadSha256(envelope.evidence) !== envelope.digest)
    throw new Error('evidence checksum mismatch');
  const evidence = envelope.evidence;
  if (evidence.provenance === 'observed' && !envelope.transcript) {
    throw new Error('observed evidence requires a sealed C-04 transcript');
  }
  if (envelope.transcript) validateBinding(envelope);
  return evidence;
}

function validateBinding(envelope: z.infer<typeof evidenceEnvelopeSchema>) {
  const checked = verifyTranscriptBytes(JSON.stringify(envelope.transcript));
  if (checked.status !== 'passed') throw new Error('invalid C-04 transcript');
  const bindingSchema = z.object({
    transcript: z.object({
      spike: z.literal('C-04'),
      capturedAt: z.string(),
      region: z.string(),
      verdict: z.string(),
      provenance: z.object({ kind: z.string() }),
      response: z.object({
        observations: z.array(z.object({ name: z.string(), value: z.unknown() })),
      }),
    }),
  });
  const bound = bindingSchema.parse(envelope.transcript).transcript;
  if (
    bound.provenance.kind !== envelope.evidence.provenance ||
    Date.parse(bound.capturedAt) !== Date.parse(envelope.evidence.capturedAt) ||
    bound.region !== envelope.evidence.region ||
    bound.verdict !== transcriptVerdict(envelope.evidence.verdict) ||
    bound.response.observations.filter(
      (item) => item.name === 'evidence-sha256' && item.value === envelope.digest,
    ).length !== 1
  ) {
    throw new Error('C-04 transcript does not bind this evidence');
  }
}

export function transcriptVerdict(verdict: RetrievalEvidence['verdict']) {
  switch (verdict) {
    case 'UNVERIFIED':
      return 'unverified';
    case 'DEFER':
      return 'defer/unavailable';
    case 'NO-GO':
      return 'no-go';
    case 'GO':
      return 'go';
  }
}
