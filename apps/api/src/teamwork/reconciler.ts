import { createScheduleWorker } from '../scheduling/worker.js';

import { RuntimeError } from './runtime-manager.js';

import type { Installation, InstallationChange, InstallationUpdate } from './installations.js';
import type { ManifestLookup, RuntimeManager } from './runtime-manager.js';

const RECONCILER_ACTOR = 'system:reconciler';

/** The slice of the installation store the reconciler needs; Postgres in the API, memory in tests. */
export type InstallationStore = {
  list(): Promise<readonly Installation[]>;
  /** Compare-and-swap on `generation`; `undefined` when the row moved or is gone. */
  update(input: InstallationUpdate): Promise<Installation | undefined>;
};

type ReconcileOutcome = 'unchanged' | 'converged' | 'failed' | 'skipped';

type Plan =
  | { readonly kind: 'settle'; readonly state: 'not_required' }
  | { readonly kind: 'fail'; readonly code: string }
  | { readonly kind: 'ensure'; readonly artifactDigest: string }
  | { readonly kind: 'remove' };

type Backoff = { readonly generation: number; readonly attempts: number; readonly until: number };

type Reconciler = {
  /** One pass over every installation; rows are independent, so one failure never blocks the rest. */
  tick(): Promise<readonly { readonly connector: string; readonly outcome: ReconcileOutcome }[]>;
  start(): void;
  stop(): Promise<void>;
};

/**
 * Converges `observed_state` toward `desired_state` and `version`. A row is claimed by a
 * compare-and-swap on `generation`, so of several reconcilers one wins and the rest skip. The claim
 * (`provisioning`) is a lease: a reconciler that died mid-call leaves it, and once it expires any
 * reconciler takes over and re-runs the idempotent runtime call. A failure never touches
 * `previous_version`, so an admin can still roll back.
 */
export function createReconciler(
  store: InstallationStore,
  options: {
    readonly segment: string;
    readonly runtime: RuntimeManager;
    readonly manifest: ManifestLookup;
    readonly now: () => Date;
    readonly onError: (error: unknown) => void;
    readonly intervalMs?: number;
    readonly leaseMs?: number;
    readonly backoff?: { readonly baseMs: number; readonly maxMs: number };
  },
): Reconciler {
  const { runtime } = options;
  const leaseMs = options.leaseMs ?? 60_000;
  const backoffConfig = options.backoff ?? { baseMs: 1000, maxMs: 60_000 };
  // In memory on purpose: a restart retries at once, and any admin write (new generation) resets it.
  const backoffs = new Map<string, Backoff>();

  const write = (
    row: Installation,
    action: string,
    change: InstallationChange,
  ): Promise<Installation | undefined> =>
    store.update({
      id: row.item_id,
      expectedGeneration: row.generation,
      actor: RECONCILER_ACTOR,
      action,
      change,
    });

  function planFor(row: Installation): Plan {
    const manifest = options.manifest(row.item_id, row.version);
    if (manifest === undefined) return { kind: 'fail', code: 'unknown_version' };
    if (manifest.runtime === undefined) return { kind: 'settle', state: 'not_required' };
    return row.desired_state === 'enabled'
      ? { kind: 'ensure', artifactDigest: manifest.runtime.artifactDigest }
      : { kind: 'remove' };
  }

  /** Observed says done; trust it only while the runtime agrees, so a deleted service is rebuilt. */
  async function inSync(plan: Plan, row: Installation): Promise<boolean> {
    const status = await runtime.status({ segment: options.segment, connector: row.item_id });
    return plan.kind === 'ensure'
      ? status.state === 'ready' &&
          status.version === row.version &&
          status.artifactDigest === plan.artifactDigest
      : status.state === 'absent';
  }

  async function settleWithoutRuntime(
    row: Installation,
    state: 'not_required' | 'failed',
    detail: string | null,
  ): Promise<ReconcileOutcome> {
    if (row.observed_state === state && row.observed_detail === detail) return 'unchanged';
    const next = await write(row, 'installation.reconcile', {
      observedState: state,
      observedDetail: detail,
    });
    if (next === undefined) return 'skipped';
    return state === 'failed' ? 'failed' : 'converged';
  }

  function backingOff(row: Installation): boolean {
    const backoff = backoffs.get(row.item_id);
    if (backoff === undefined) return false;
    if (backoff.generation !== row.generation) {
      backoffs.delete(row.item_id);
      return false;
    }
    return options.now().getTime() < backoff.until;
  }

  function recordFailure(id: string, generation: number): void {
    const attempts = (backoffs.get(id)?.attempts ?? 0) + 1;
    const delay = Math.min(backoffConfig.baseMs * 2 ** (attempts - 1), backoffConfig.maxMs);
    backoffs.set(id, { generation, attempts, until: options.now().getTime() + delay });
  }

  async function drive(row: Installation, plan: Plan & { kind: 'ensure' | 'remove' }) {
    const ref = { segment: options.segment, connector: row.item_id };
    try {
      if (plan.kind === 'remove') {
        await runtime.remove(ref);
        return null;
      }
      const status = await runtime.ensure({
        ...ref,
        version: row.version,
        artifactDigest: plan.artifactDigest,
      });
      return status.state === 'ready' ? null : 'health_check_failed';
    } catch (error) {
      return error instanceof RuntimeError ? error.code : 'runtime_error';
    }
  }

  async function reconcile(row: Installation): Promise<ReconcileOutcome> {
    const plan = planFor(row);
    if (plan.kind === 'settle') return settleWithoutRuntime(row, plan.state, null);
    if (plan.kind === 'fail') return settleWithoutRuntime(row, 'failed', plan.code);

    const leased =
      row.observed_state === 'provisioning' &&
      options.now().getTime() - row.updated_at.getTime() < leaseMs;
    if (leased || backingOff(row)) return 'skipped';

    const settled = plan.kind === 'ensure' ? 'healthy' : 'disabled';
    if (row.observed_state === settled && (await inSync(plan, row))) return 'unchanged';
    return converge(row, plan, settled);
  }

  async function converge(
    row: Installation,
    plan: Plan & { kind: 'ensure' | 'remove' },
    settled: 'healthy' | 'disabled',
  ): Promise<ReconcileOutcome> {
    const claimed = await write(row, 'installation.reconcile.claim', {
      observedState: 'provisioning',
      observedDetail: null,
    });
    if (claimed === undefined) return 'skipped';

    const failure = await drive(row, plan);
    const done = await write(claimed, 'installation.reconcile', {
      observedState: failure === null ? settled : 'failed',
      observedDetail: failure,
    });
    // The row moved while the runtime call ran (an admin write); the next pass plans from the new row.
    if (done === undefined) return 'skipped';
    if (failure === null) {
      backoffs.delete(row.item_id);
      return 'converged';
    }
    recordFailure(row.item_id, done.generation);
    return 'failed';
  }

  async function tick() {
    const results: { connector: string; outcome: ReconcileOutcome }[] = [];
    for (const row of await store.list()) {
      try {
        results.push({ connector: row.item_id, outcome: await reconcile(row) });
      } catch (error) {
        options.onError(error);
        results.push({ connector: row.item_id, outcome: 'skipped' });
      }
    }
    return results;
  }

  return {
    tick,
    ...createScheduleWorker(
      {
        tick: async () => {
          await tick();
        },
      },
      options.onError,
      options.intervalMs ?? 5000,
    ),
  };
}
