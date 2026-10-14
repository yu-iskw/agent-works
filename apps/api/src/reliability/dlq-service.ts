import { dlqEntrySchema } from './dlq-types.js';

import type { DlqDecision, DlqEntry, DlqStore } from './dlq-types.js';
import type { DispatchPort } from '../ports/dispatch-port.js';
import type { TaskLedger } from '../ports/ledger-port.js';
import type { LeaseProof } from '@agent-works/domain';

export type OperatorReview = {
  readonly decisionId: string;
  readonly operator: string;
  readonly reason: string;
  readonly occurredAt: string;
};
export class DlqReviewError extends Error {
  constructor(
    readonly code:
      | 'missing'
      | 'closed'
      | 'risky_write_requires_compensation'
      | 'completed_receipt'
      | 'lease'
      | 'evidence',
  ) {
    super(code);
    this.name = 'DlqReviewError';
  }
}
function decision(
  entry: DlqEntry,
  review: OperatorReview,
  action: DlqDecision['action'],
  evidenceRef: string | null,
): DlqDecision {
  for (const value of [review.decisionId, review.operator, review.reason])
    if (value.trim().length === 0) throw new DlqReviewError('evidence');
  if (!Number.isFinite(Date.parse(review.occurredAt))) throw new DlqReviewError('evidence');
  return { ...review, entryId: entry.entryId, action, evidenceRef };
}
export function createDlqService(store: DlqStore, dispatch: DispatchPort, ledger: TaskLedger) {
  async function reviewed(entryId: string): Promise<DlqEntry> {
    const entry = await store.read(entryId);
    if (entry === undefined) throw new DlqReviewError('missing');
    if (entry.state === 'requeued' || entry.state === 'compensated')
      throw new DlqReviewError('closed');
    return entry;
  }
  return {
    list() {
      return store.list();
    },
    async stuck(input: Omit<DlqEntry, 'state' | 'version'>): Promise<DlqEntry> {
      const task = await ledger.read(input.subject, input.taskId);
      if (task === undefined) throw new DlqReviewError('missing');
      if (
        (await ledger.readReceipt(input.subject, input.taskId)) !== undefined ||
        task.status === 'COMPLETED'
      )
        throw new DlqReviewError('completed_receipt');
      return store.add(dlqEntrySchema.parse({ ...input, state: 'review', version: 1 }));
    },
    /** Caller must acquire a current task lease through the dispatch port. We never create a new claim key. */
    async requeue(
      entryId: string,
      review: OperatorReview,
      lease: LeaseProof,
      at: string,
      attempt: number,
    ): Promise<DlqEntry> {
      const entry = await reviewed(entryId);
      if (entry.riskyWrite) throw new DlqReviewError('risky_write_requires_compensation');
      if (lease.taskId !== entry.taskId) throw new DlqReviewError('lease');
      const task = await ledger.read(entry.subject, entry.taskId);
      if (
        task === undefined ||
        ['COMPLETED', 'CANCELLED', 'FAILED', 'BLOCKED_AUTH'].includes(task.status) ||
        (await ledger.readReceipt(entry.subject, entry.taskId)) !== undefined
      )
        throw new DlqReviewError('completed_receipt');
      const evidence = decision(entry, review, 'requeue', null);
      // Persist intent first. A crash leaves reviewable pending work, never an unrecorded replay.
      const pending = { ...entry, state: 'requeue_pending' as const, version: entry.version + 1 };
      await store.decide(pending, evidence, entry.version);
      await dispatch.scheduleRetry(lease, at, attempt);
      const complete = { ...pending, state: 'requeued' as const, version: pending.version + 1 };
      await store.decide(
        complete,
        { ...evidence, decisionId: `${evidence.decisionId}:scheduled` },
        pending.version,
      );
      return complete;
    },
    /** Records independently executed compensation; it does not call a write adapter. */
    async compensate(
      entryId: string,
      review: OperatorReview,
      evidenceRef: string,
    ): Promise<DlqEntry> {
      const entry = await reviewed(entryId);
      if (evidenceRef.trim().length === 0) throw new DlqReviewError('evidence');
      const next = { ...entry, state: 'compensated' as const, version: entry.version + 1 };
      await store.decide(next, decision(entry, review, 'compensate', evidenceRef), entry.version);
      return next;
    },
  };
}
