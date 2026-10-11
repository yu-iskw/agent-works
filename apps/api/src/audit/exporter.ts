import { canonicalPayloadSha256 } from '@agent-works/domain';

import type { ExporterPort } from '../ports/exporter-port.js';
import type { AuditEvent, OutboxEvent } from '@agent-works/domain';

export type SealedLink = {
  readonly digest: string;
  readonly event: AuditEvent;
};

export type ExportReceipt = 'exported' | 'duplicate';

export type ChainVerdict = 'intact' | 'tampered';

export interface ExportLog {
  links(): readonly SealedLink[];
  append(link: SealedLink): void;
}

const redactedMark = '[redacted]';

export function createExportLog(): ExportLog {
  const stored: SealedLink[] = [];
  return {
    links: () => stored,
    append(link) {
      stored.push(link);
    },
  };
}

export function drain(events: readonly OutboxEvent[], log: ExportLog): readonly ExportReceipt[] {
  const seen = new Set(log.links().map((link) => link.event.eventId));
  const receipts: ExportReceipt[] = [];
  for (const incoming of events) receipts.push(exportOne(incoming, log, seen));
  return receipts;
}

export function verifyChain(links: readonly SealedLink[]): ChainVerdict {
  let previous: string | null = null;
  for (const link of links) {
    if (link.event.prevDigest !== previous) return 'tampered';
    if (canonicalPayloadSha256(link.event) !== link.digest) return 'tampered';
    previous = link.digest;
  }
  return 'intact';
}

export function createExporter(log: ExportLog): ExporterPort {
  return {
    exportEvent(event) {
      return Promise.resolve().then(() => drain([event], log)[0]);
    },
  };
}

function exportOne(incoming: OutboxEvent, log: ExportLog, seen: Set<string>): ExportReceipt {
  const eventId = incoming.event.eventId;
  if (seen.has(eventId)) return 'duplicate';
  const previous = log.links().at(-1)?.digest ?? null;
  log.append(seal(incoming.event, previous));
  seen.add(eventId);
  return 'exported';
}

function seal(event: AuditEvent, prevDigest: string | null): SealedLink {
  const sealed: AuditEvent = { ...redactAuditEvent(event), prevDigest };
  return { digest: canonicalPayloadSha256(sealed), event: sealed };
}

function redactAuditEvent(event: AuditEvent): AuditEvent {
  return {
    eventId: event.eventId,
    eventType: event.eventType,
    schemaVersion: event.schemaVersion,
    occurredAt: event.occurredAt,
    taskId: event.taskId,
    stepId: event.stepId,
    traceId: event.traceId,
    initiatorSubject: event.initiatorSubject,
    agentPrincipal: event.agentPrincipal,
    tool: redactNullable(event.tool),
    policyDecisionId: redactNullable(event.policyDecisionId),
    approvalId: redactNullable(event.approvalId),
    requestDigestSha256: event.requestDigestSha256,
    outcome: redactText(event.outcome),
    externalObjectRef: redactNullable(event.externalObjectRef),
    prevDigest: event.prevDigest,
  };
}

function redactNullable(value: string | null): string | null {
  if (value === null) return null;
  return redactText(value);
}

function redactText(value: string): string {
  let redacted = value;
  for (const pattern of secretPatterns()) redacted = redacted.replace(pattern, redactedMark);
  return redacted;
}

function secretPatterns(): readonly RegExp[] {
  return [
    /(?<![A-Za-z0-9])Bearer\s+[A-Za-z0-9._~+/=-]{8,}/gi,
    /(?<![A-Za-z0-9])ya29\.[A-Za-z0-9._-]+/g,
    /(?<![A-Za-z0-9])(?:oauth_token|access_token)(?:"\s*:\s*"[^"]*"|\s*[:=]\s*\S+|\s*%3D\S+)/gi,
    /(?<![A-Za-z0-9])sk-[A-Za-z0-9_-]{8,}/g,
    /(?<![A-Za-z0-9])ghp_[A-Za-z0-9]{8,}/g,
  ];
}
