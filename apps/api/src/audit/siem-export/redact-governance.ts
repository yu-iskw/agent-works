import {
  governanceClassificationSchema,
  governanceHash,
} from '@agent-works/domain/data-governance';

import type {
  GovernanceAudit,
  GovernanceClassification,
} from '@agent-works/domain/data-governance';

const RESTRICTED_MASK = '[RESTRICTED]';
/** Arbitrary task data is untrusted. Classification is supplied by the producer,
 * and the root classification is an inherited floor for every nested field. */
export function redactClassifiedPayload(
  value: unknown,
  classification: GovernanceClassification,
  depth = 0,
): unknown {
  governanceClassificationSchema.parse(classification);
  if (classification === 'RESTRICTED') return RESTRICTED_MASK;
  if (depth > 32) return '[DEPTH-LIMIT]';
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value))
    return value.map((item: unknown) => redactClassifiedPayload(item, classification, depth + 1));
  const entries = Object.entries(value as Record<string, unknown>);
  const label = entries.find(([key]) => key === 'classification')?.[1];
  const parsed = governanceClassificationSchema.safeParse(label);
  // Malformed explicit labels never downgrade to the inherited classification.
  if (
    entries.some(([key]) => key === 'classification') &&
    (!parsed.success || parsed.data === 'RESTRICTED')
  )
    return RESTRICTED_MASK;
  const output = new Map<string, unknown>();
  for (const [key, item] of entries) {
    if (['__proto__', 'constructor', 'prototype'].includes(key)) continue;
    output.set(key, redactClassifiedPayload(item, classification, depth + 1));
  }
  return Object.fromEntries(output);
}
export function governanceSiemMarker(event: GovernanceAudit): Readonly<Record<string, unknown>> {
  return Object.freeze({
    version: '1',
    event_id: governanceHash(event.eventId),
    event_type: event.type,
    occurred_at: event.occurredAt,
    target_digest: event.targetHash,
    actor_digest: event.actorHash,
    deletion_request: event.requestId === null ? null : governanceHash(event.requestId),
    state: event.state,
    redaction_marker: event.redactionMarker,
  });
}
