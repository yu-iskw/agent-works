import type { RetryConfig } from '../queue/cloud-tasks-config.js';

export type ExecutionState =
  | 'queued'
  | 'running'
  | 'awaiting-reconciliation'
  | 'succeeded'
  | 'failed'
  | 'denied'
  | 'cancelled'
  | 'quarantined';

export type FailureClass = 'retryable' | 'permanent' | 'denied' | 'uncertain';

/**
 * Explicit budgets. `retry.maxAttempts` bounds attempts, `retry.maxRetryDurationSeconds` bounds the
 * whole execution from first handoff, and the backoff fields feed the SCH-03 `backoffSeconds`.
 */
export type WorkerBudget = {
  readonly retry: RetryConfig;
  readonly leaseMs: number;
  /** Returns [0,1). Injectable so backoff is testable. */
  readonly random?: () => number;
};

/** What a runner holds after claiming. `fence` is the compare-and-swap token for every commit. */
export type Claim = {
  readonly executionId: string;
  readonly fence: number;
  readonly attempt: number;
  readonly owner: string;
  readonly checkpointVersion: number;
  readonly checkpointRef: string | null;
};

const terminal: readonly ExecutionState[] = ['succeeded', 'failed', 'denied', 'cancelled'];
export const isTerminal = (state: ExecutionState): boolean => terminal.includes(state);

/** The runner lost its lease or the row moved on. Nothing it holds may be committed. */
export class StaleWorker extends Error {
  constructor(readonly executionId: string) {
    super(`stale worker for ${executionId}`);
    this.name = 'StaleWorker';
  }
}

const CLASS = /^[a-z0-9._-]{1,64}$/;
export const sanitizeErrorClass = (value: string): string =>
  CLASS.test(value) ? value : 'unknown';

/** A classified failure. Only the class strings are persisted, never provider text. */
export class WorkerFailure extends Error {
  readonly errorClass: string;
  constructor(
    readonly failureClass: FailureClass,
    errorClass: string,
  ) {
    super(`worker failure: ${failureClass}`);
    this.name = 'WorkerFailure';
    this.errorClass = sanitizeErrorClass(errorClass);
  }
}

/** The provider definitely did not apply the write (for example a validation rejection). */
export class EffectNotApplied extends Error {
  constructor(
    readonly errorClass: string,
    readonly retryable: boolean,
  ) {
    super(`effect not applied: ${errorClass}`);
    this.name = 'EffectNotApplied';
  }
}

export class EffectDenied extends WorkerFailure {
  constructor(reason: string) {
    super('denied', reason);
    this.name = 'EffectDenied';
  }
}

/** The effect may have been applied; it will not be replayed until read-back or an operator resolves it. */
export class EffectUncertain extends WorkerFailure {
  constructor(readonly effectKey: string) {
    super('uncertain', 'effect-uncertain');
    this.name = 'EffectUncertain';
  }
}

/** Same effect key with a different payload digest or provider target: a changed-input replay. */
export class EffectKeyConflict extends WorkerFailure {
  constructor(readonly effectKey: string) {
    super('permanent', 'effect-key-conflict');
    this.name = 'EffectKeyConflict';
  }
}
