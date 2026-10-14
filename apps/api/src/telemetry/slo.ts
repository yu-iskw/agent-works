import { structuredEventSchema } from './events.js';

import type { StructuredEvent } from './events.js';

export type SloTargets = {
  readonly approval: 'PLACEHOLDER';
  readonly acceptanceP95Ms: number;
  readonly approvalPersistenceP95Ms: number;
};
export type SloReport = {
  readonly approval: 'PLACEHOLDER';
  readonly events: number;
  readonly acceptance: { samples: number; p95Ms: number | null; targetMs: number; verdict: string };
  readonly approvalPersistence: {
    samples: number;
    p95Ms: number | null;
    targetMs: number;
    verdict: string;
  };
  readonly auditCapture: {
    receipts: number;
    matched: number;
    missing: readonly string[];
    unexpected: readonly string[];
    ratio: number | null;
    verdict: string;
  };
  readonly duplicateSideEffects: { count: number; keys: readonly string[]; verdict: string };
};
export function uniqueEvents(input: readonly StructuredEvent[]): readonly StructuredEvent[] {
  const events = new Map<string, StructuredEvent>();
  for (const value of input) {
    const event = structuredEventSchema.parse(value);
    const previous = events.get(event.event_id);
    if (previous !== undefined && JSON.stringify(previous) !== JSON.stringify(event))
      throw new Error('event identity conflict');
    events.set(event.event_id, event);
  }
  return [...events.values()].sort((a, b) => a.event_id.localeCompare(b.event_id, 'en'));
}
export function percentile95(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  return [...values].sort((a, b) => a - b)[Math.ceil(values.length * 0.95) - 1];
}
function measure(
  events: readonly StructuredEvent[],
  kind: StructuredEvent['kind'],
  targetMs: number,
) {
  if (!Number.isFinite(targetMs) || targetMs < 0) throw new RangeError('PLACEHOLDER target');
  const values = events
    .filter((event) => event.kind === kind && event.outcome === 'success')
    .map((event) => event.latency_ms);
  const p95Ms = percentile95(values);
  return {
    samples: values.length,
    p95Ms,
    targetMs,
    verdict: p95Ms === null ? 'no_data' : p95Ms < targetMs ? 'pass' : 'fail',
  };
}
function effectIdentity(event: StructuredEvent): string {
  if (event.side_effect_key === null) throw new Error('side effect identity missing');
  return `${event.task_id}:${event.side_effect_key}`;
}
export function sloReport(input: readonly StructuredEvent[], targets: SloTargets): SloReport {
  const events = uniqueEvents(input);
  const receipts = events.filter(
    (event) => event.kind === 'tool.receipt' && event.outcome === 'success',
  );
  const audits = events.filter(
    (event) => event.kind === 'audit.captured' && event.outcome === 'success',
  );
  const receiptKeys = receipts.map(effectIdentity);
  const auditKeys = audits.map(effectIdentity);
  const writes = new Set(receiptKeys);
  const captured = new Set(auditKeys);
  const missing = [...writes].filter((key) => !captured.has(key)).sort();
  const unexpected = [...captured].filter((key) => !writes.has(key)).sort();
  const duplicates = [...writes]
    .filter((key) => receiptKeys.filter((value) => value === key).length > 1)
    .sort();
  const matched = writes.size - missing.length;
  return {
    approval: 'PLACEHOLDER',
    events: events.length,
    acceptance: measure(events, 'task.accepted', targets.acceptanceP95Ms),
    approvalPersistence: measure(events, 'approval.persisted', targets.approvalPersistenceP95Ms),
    auditCapture: {
      receipts: writes.size,
      matched,
      missing,
      unexpected,
      ratio: writes.size === 0 ? null : matched / writes.size,
      verdict:
        writes.size === 0
          ? 'no_data'
          : missing.length === 0 && unexpected.length === 0 && auditKeys.length === captured.size
            ? 'pass'
            : 'fail',
    },
    duplicateSideEffects: {
      count: receiptKeys.length - writes.size,
      keys: duplicates,
      verdict: duplicates.length === 0 ? 'pass' : 'fail',
    },
  };
}
