import {
  governanceSiemMarker,
  redactClassifiedPayload,
} from '../audit/siem-export/redact-governance.js';

import type { GovernanceClassification } from './model.js';
import type { GovernancePort } from '../ports/governance.js';

/** Safe boundary for the governance task-event producer and local SIEM exporter.
 * Existing task routes and SIEM chain implementation remain independently owned. */
export function classifiedTaskEvent(
  taskId: string,
  payload: unknown,
  classification: GovernanceClassification,
): Readonly<Record<string, unknown>> {
  return Object.freeze({
    taskId,
    classification,
    payload: redactClassifiedPayload(payload, classification),
  });
}
export async function exportGovernanceMarkers(
  port: GovernancePort,
  append: (event: Readonly<Record<string, unknown>>) => Promise<void>,
): Promise<number> {
  const { audit } = await port.snapshot();
  const ordered = [...audit].sort(
    (a, b) =>
      a.occurredAt.localeCompare(b.occurredAt, 'en') || a.eventId.localeCompare(b.eventId, 'en'),
  );
  for (const event of ordered) await append(governanceSiemMarker(event));
  return ordered.length;
}
