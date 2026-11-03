import { createEffectRunner } from './effects.js';
import {
  claimNext,
  commitCheckpoint,
  completeExecution,
  failExecution,
  renewLease,
} from './store.js';
import {
  EffectNotApplied,
  EffectUncertain,
  StaleWorker,
  WorkerFailure,
  sanitizeErrorClass,
} from './types.js';

import type { EffectGate, EffectProvider, EffectSpec } from './effects.js';
import type { Claim, ExecutionState, WorkerBudget } from './types.js';
import type postgres from 'postgres';

/** What a handler may do. Every method is fenced; a lost lease surfaces as `StaleWorker`. */
type StepContext = {
  readonly claim: Claim;
  /** Resume point from the last committed checkpoint. */
  readonly checkpoint: { readonly version: number; readonly ref: string | null };
  saveCheckpoint(ref: string): Promise<void>;
  renew(): Promise<void>;
  /** Throws `EffectUncertain` when the outcome is unknown, so a handler cannot treat it as success. */
  effect(spec: EffectSpec, provider: EffectProvider): Promise<'written' | 'recorded' | 'read-back'>;
};

type ExecutionHandler = (context: StepContext) => Promise<{ readonly resultDigest: string }>;

export type RunResult =
  | { readonly kind: 'idle' }
  | { readonly kind: 'stale'; readonly executionId: string }
  | { readonly kind: 'ran'; readonly executionId: string; readonly state: ExecutionState };

export type WorkerDeps = {
  readonly sql: postgres.Sql;
  readonly owner: string;
  readonly budget: WorkerBudget;
  readonly gate: EffectGate;
  readonly handler: ExecutionHandler;
  readonly now?: () => string;
};

/** One claim-run-commit cycle. Run it in a loop; each pass is independent and database-driven. */
export function createExecutionWorker(deps: WorkerDeps): { runOnce(): Promise<RunResult> } {
  const now = deps.now ?? (() => new Date().toISOString());
  const runEffect = createEffectRunner(deps.sql, deps.gate, now);

  function contextFor(claim: Claim): StepContext {
    let version = claim.checkpointVersion;
    return {
      claim,
      checkpoint: { version, ref: claim.checkpointRef },
      async saveCheckpoint(ref) {
        const next = version + 1;
        const res = await commitCheckpoint(deps.sql, claim, { version: next, ref, now: now() });
        if (res === 'stale') throw new StaleWorker(claim.executionId);
        version = next;
      },
      async renew() {
        const res = await renewLease(deps.sql, claim, { now: now(), budget: deps.budget });
        if (res === 'stale') throw new StaleWorker(claim.executionId);
      },
      async effect(spec, provider) {
        const outcome = await runEffect(claim, spec, provider);
        if (outcome.kind === 'uncertain') throw new EffectUncertain(spec.key);
        return outcome.source;
      },
    };
  }

  function classify(error: unknown): {
    failureClass: WorkerFailure['failureClass'];
    errorClass: string;
  } {
    if (error instanceof WorkerFailure) {
      return { failureClass: error.failureClass, errorClass: error.errorClass };
    }
    if (error instanceof EffectNotApplied) {
      return {
        failureClass: error.retryable ? 'retryable' : 'permanent',
        errorClass: sanitizeErrorClass(error.errorClass),
      };
    }
    return { failureClass: 'retryable', errorClass: 'unknown' };
  }

  return {
    async runOnce() {
      const claim = await claimNext(deps.sql, {
        now: now(),
        owner: deps.owner,
        budget: deps.budget,
      });
      if (claim === undefined) return { kind: 'idle' };
      const { executionId } = claim;
      let outcome: { resultDigest: string } | { error: unknown };
      try {
        outcome = await deps.handler(contextFor(claim));
      } catch (error) {
        outcome = { error };
      }
      if ('error' in outcome) {
        if (outcome.error instanceof StaleWorker) return { kind: 'stale', executionId };
        const failed = await failExecution(deps.sql, claim, {
          ...classify(outcome.error),
          now: now(),
          budget: deps.budget,
        });
        return failed.committed
          ? { kind: 'ran', executionId, state: failed.state }
          : { kind: 'stale', executionId };
      }
      const done = await completeExecution(deps.sql, claim, {
        resultDigest: outcome.resultDigest,
        now: now(),
      });
      return done === 'committed'
        ? { kind: 'ran', executionId, state: 'succeeded' }
        : { kind: 'stale', executionId };
    },
  };
}
