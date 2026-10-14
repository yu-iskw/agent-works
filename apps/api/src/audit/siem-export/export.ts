import { projectAudit } from './format.js';

import type { SealedExport } from './format.js';
import type { SiemSink } from './sink-port.js';
import type { Redactor } from '../../telemetry/events-redaction.js';
import type { AuditEvent } from '@agent-works/domain';

/** Deliberately separate from the existing exporter: caller opts in with a sink and protected key. */
export async function exportSecurityEvents(
  events: readonly AuditEvent[],
  sink: SiemSink,
  redactor: Redactor,
): Promise<readonly SealedExport[]> {
  const ordered = [...events].sort(
    (a, b) =>
      a.occurredAt.localeCompare(b.occurredAt, 'en') || a.eventId.localeCompare(b.eventId, 'en'),
  );
  const links: SealedExport[] = [];
  for (const event of ordered) links.push(await sink.append(projectAudit(event, redactor)));
  return links;
}
