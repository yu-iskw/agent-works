import { verifyExports } from './format.js';

import type { SealedExport } from './format.js';
import type { Redactor } from '../../telemetry/events-redaction.js';

export type SideEffectReceipt = {
  readonly taskId: string;
  readonly stepId: string;
  readonly tool: string;
  readonly ref: string;
  readonly requestDigest: string;
};
export type Reconciliation = {
  readonly expected: number;
  readonly matched: number;
  readonly missing: readonly string[];
  readonly unexpected: readonly string[];
  readonly duplicate: readonly string[];
  readonly pass: boolean;
};
function receiptKey(receipt: SideEffectReceipt, redactor: Redactor): string {
  return JSON.stringify([
    redactor.protect(receipt.taskId),
    redactor.protect(receipt.stepId),
    redactor.protect(receipt.tool),
    redactor.protect(receipt.ref),
    receipt.requestDigest,
  ]);
}
/** Compares independently collected external receipts, not exports with themselves. */
export function reconcileReceipts(
  receipts: readonly SideEffectReceipt[],
  exports: readonly SealedExport[],
  redactor: Redactor,
): Reconciliation {
  verifyExports(exports);
  const expected = receipts.map((receipt) => receiptKey(receipt, redactor));
  const actual = exports
    .filter((link) => link.event.receipt_ref !== null && link.event.outcome === 'success')
    .map(({ event }) =>
      JSON.stringify([
        event.task_id,
        event.step_id,
        event.tool,
        event.receipt_ref,
        event.request_digest,
      ]),
    );
  const expectedSet = new Set(expected);
  const actualSet = new Set(actual);
  const missing = [...expectedSet].filter((key) => !actualSet.has(key)).sort();
  const unexpected = [...actualSet].filter((key) => !expectedSet.has(key)).sort();
  const duplicate = [
    ...new Set([
      ...expected.filter((key, index) => expected.indexOf(key) !== index),
      ...actual.filter((key, index) => actual.indexOf(key) !== index),
    ]),
  ].sort();
  return {
    expected: expected.length,
    matched: expectedSet.size - missing.length,
    missing,
    unexpected,
    duplicate,
    pass: missing.length === 0 && unexpected.length === 0 && duplicate.length === 0,
  };
}
export function assertReceiptReconciliation(
  receipts: readonly SideEffectReceipt[],
  exports: readonly SealedExport[],
  redactor: Redactor,
): Reconciliation {
  const report = reconcileReceipts(receipts, exports, redactor);
  if (!report.pass) throw new Error('SIEM write reconciliation failed');
  return report;
}
