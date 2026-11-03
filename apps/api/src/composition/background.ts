import { createOutboxPublisher } from '../outbox/publisher.js';
import { outboxReady } from '../outbox/migration.js';
import { createScheduleWorker } from '../scheduling/worker.js';
import { workerReady } from '../worker/migration.js';
import { createExecutionWorker } from '../worker/runner.js';
import { sweep } from '../worker/sweeper.js';

import { WiringConfigError } from './flags.js';

import type { Wiring } from './flags.js';
import type { AdmissionService } from '../admission/postgres-admission.js';
import type { QueuePublisher } from '../outbox/publisher.js';
import type { EffectGate } from '../worker/effects.js';
import type { WorkerDeps } from '../worker/runner.js';
import type postgres from 'postgres';

export type Loop = { start(): void; stop(): Promise<void> };

/** What a real step needs. The process has none built in, so enabling the worker without one is refused. */
export type ExecutionRuntime = {
  readonly gate: EffectGate;
  readonly handler: WorkerDeps['handler'];
};

export type BackgroundInput = {
  readonly sql: postgres.Sql;
  readonly wiring: Wiring;
  readonly now: () => Date;
  readonly onError: (error: unknown) => void;
  readonly admission?: AdmissionService;
  readonly routines?: { sweep(): Promise<readonly string[]> };
  readonly routineSweepMs?: number;
  /** Required when the outbox publisher is enabled. */
  readonly queue?: QueuePublisher;
  /** Required when the execution worker is enabled. */
  readonly execution?: ExecutionRuntime;
};

const loop = (tick: () => Promise<unknown>, onError: (error: unknown) => void, ms: number): Loop =>
  createScheduleWorker({ tick: async () => void (await tick()) }, onError, ms);

const maxRunsPerTick = 25;

/**
 * Builds only the loops whose capability is enabled; with every flag off the list is empty and the
 * process starts exactly the loops it started before. Each loop is stoppable, and `stop` waits for
 * the tick in flight, so shutdown never abandons a half-finished batch.
 */
export async function buildBackgroundLoops(input: BackgroundInput): Promise<readonly Loop[]> {
  const { sql, wiring, onError } = input;
  const stamp = () => input.now().toISOString();
  const loops: Loop[] = [];
  if (wiring.admission !== undefined && input.admission !== undefined) {
    const { admission } = input;
    loops.push(loop(() => admission.sweepExpired(), onError, wiring.admission.sweepMs));
  }
  if (input.routines !== undefined) {
    const { routines } = input;
    loops.push(loop(() => routines.sweep(), onError, input.routineSweepMs ?? 60_000));
  }
  if (wiring.outbox !== undefined) {
    if (input.queue === undefined)
      throw new WiringConfigError(['AW_OUTBOX_PUBLISHER requires a queue publisher']);
    await outboxReady(sql);
    const outbox = wiring.outbox;
    const publisher = createOutboxPublisher(sql, input.queue, {
      owner: outbox.owner,
      leaseMs: outbox.leaseMs,
      maxAttempts: outbox.maxAttempts,
      baseBackoffMs: 1000,
      maxBackoffMs: 600_000,
    });
    loops.push(
      loop(
        () => publisher.publishBatch({ now: stamp(), limit: outbox.batch }),
        onError,
        outbox.intervalMs,
      ),
    );
  }
  if (wiring.sweeper !== undefined) {
    const { budget, redriveAfterMs, maxRedrives, limit, intervalMs } = wiring.sweeper;
    loops.push(
      loop(
        () => sweep(sql, { now: stamp(), budget, redriveAfterMs, maxRedrives, limit }),
        onError,
        intervalMs,
      ),
    );
  }
  if (wiring.executionWorker !== undefined) {
    if (input.execution === undefined)
      throw new WiringConfigError([
        'AW_EXECUTION_WORKER requires a registered execution handler and effect gate; none is built in',
      ]);
    await workerReady(sql);
    const worker = createExecutionWorker({
      sql,
      owner: `worker-${process.pid}`,
      budget: wiring.executionWorker.budget,
      gate: input.execution.gate,
      handler: input.execution.handler,
    });
    loops.push(
      loop(
        async () => {
          for (let run = 0; run < maxRunsPerTick; run += 1)
            if ((await worker.runOnce()).kind === 'idle') return;
        },
        onError,
        wiring.executionWorker.intervalMs,
      ),
    );
  }
  return loops;
}
