import { serializeDispatchEnvelope } from '@agent-works/domain';

import { claimBatch, markFailed, markPublished, reconcileLeases } from './store.js';

import type { OutboxLease } from './store.js';
import type postgres from 'postgres';

export type QueueMessage = {
  readonly dispatchId: string;
  /** Stable Cloud Tasks name derived from dispatchId. */
  readonly transportName: string;
  readonly body: string;
};

/**
 * Transport port. Resolving means the queue holds the message: `created` for a fresh task,
 * `exists` when the stable name already exists (a prior attempt whose ack was lost).
 */
export type QueuePublisher = {
  publish(message: QueueMessage): Promise<'created' | 'exists'>;
};

/** A classified publish failure. Only the class is persisted, never provider text. */
export class QueuePublishError extends Error {
  constructor(
    readonly errorClass: string,
    readonly retryable: boolean,
  ) {
    super(`queue publish failed: ${errorClass}`);
  }
}

export type PublisherOptions = {
  owner: string;
  leaseMs: number;
  maxAttempts: number;
  baseBackoffMs: number;
  maxBackoffMs: number;
  /** Returns [0,1). Injectable so backoff is testable. */
  random?: () => number;
};
type PublishReport = {
  published: number;
  retried: number;
  abandoned: number;
  superseded: number;
};

const CLASS = /^[a-z0-9._-]{1,64}$/;
const classify = (error: unknown): { errorClass: string; retryable: boolean } =>
  error instanceof QueuePublishError
    ? {
        errorClass: CLASS.test(error.errorClass) ? error.errorClass : 'unknown',
        retryable: error.retryable,
      }
    : { errorClass: 'unknown', retryable: true };

/** Capped exponential backoff with equal jitter: half fixed, half random. */
function backoffMs(attempts: number, o: PublisherOptions): number {
  const ceiling = Math.min(o.maxBackoffMs, o.baseBackoffMs * 2 ** Math.max(0, attempts - 1));
  return Math.floor(ceiling / 2 + (o.random ?? Math.random)() * (ceiling / 2));
}

export type OutboxPublisher = {
  /**
   * Reconcile expired leases, claim a batch, then publish each event with no transaction open.
   * Completion is fenced, so a publisher that lost its lease cannot overwrite a newer outcome.
   */
  publishBatch(input: { now: string; limit: number }): Promise<PublishReport>;
};

export function createOutboxPublisher(
  sql: postgres.Sql,
  queue: QueuePublisher,
  options: PublisherOptions,
): OutboxPublisher {
  const retryAt = (now: string, ms: number) => new Date(Date.parse(now) + ms).toISOString();
  async function publishOne(lease: OutboxLease, now: string): Promise<keyof PublishReport> {
    try {
      await queue.publish({
        dispatchId: lease.dispatchId,
        transportName: lease.transportName,
        body: serializeDispatchEnvelope(lease.envelope),
      });
    } catch (error) {
      const { errorClass, retryable } = classify(error);
      const result = await markFailed(sql, lease, {
        now,
        errorClass,
        retryable,
        retryAt: retryAt(now, backoffMs(lease.attempts, options)),
        maxAttempts: options.maxAttempts,
      });
      return result === 'retry' ? 'retried' : result;
    }
    return (await markPublished(sql, lease, now)) ? 'published' : 'superseded';
  }
  return {
    async publishBatch({ now, limit }) {
      await reconcileLeases(sql, { now, maxAttempts: options.maxAttempts });
      const leases = await claimBatch(sql, {
        now,
        limit,
        owner: options.owner,
        leaseMs: options.leaseMs,
        maxAttempts: options.maxAttempts,
      });
      const report: PublishReport = { published: 0, retried: 0, abandoned: 0, superseded: 0 };
      for (const lease of leases) report[await publishOne(lease, now)] += 1;
      return report;
    },
  };
}
