import { BOT_RUN_TERMINAL } from '@agent-works/domain';

import { recheck } from './recheck.js';
import { event, moveRun, moveStep } from './store.js';

import type { createBotGraph } from './graph.js';
import type { createBotLease } from './lease.js';
import type { BotJob, ExecutionOptions, RunRow, StepRow } from './types.js';
import type { Tx } from '../../context.js';

type Settlement = { output?: string; code?: string; cost?: StepRow['cost'] } & (
  | { status: 'failed'; effectNotSent: true }
  | { status: 'succeeded' | 'failed' | 'outcome_uncertain'; effectNotSent?: never }
);
export function createBotSettlement(
  options: ExecutionOptions,
  lease: ReturnType<typeof createBotLease>,
  graph: ReturnType<typeof createBotGraph>,
) {
  const { deps } = options;
  async function accepted(tx: Tx, run: RunRow, step: StepRow, outcome: Settlement) {
    await moveStep(deps, tx, step, outcome.status, outcome.code ?? null);
    await tx`update tw_bot_steps set output=${outcome.output === undefined ? null : tx.json({ text: outcome.output })},cost=coalesce(${outcome.cost ? tx.json(outcome.cost) : null}::jsonb,cost)
      where task_id=${run.task_id} and step_id=${step.step_id}`;
    if (outcome.status === 'succeeded' && step.kind === 'result') {
      if (run.status !== 'running') await moveRun(deps, tx, run, 'running');
      await tx`update tw_bot_runs set result_text=${outcome.output ?? null} where task_id=${run.task_id}`;
      await moveRun(deps, tx, run, 'completed');
    } else await graph.advance(tx, run);
  }
  return async (job: BotJob, outcome: Settlement) => {
    let released: RunRow | undefined;
    await deps.sql.begin(async (tx) => {
      const state = await lease.owned(tx, job, true);
      if (!state) return;
      const { run, step } = state;
      if (outcome.effectNotSent)
        await tx`update tw_bot_steps set idempotency_key=null,cost=null where task_id=${run.task_id} and step_id=${step.step_id}`;
      if (run.status === 'cancel_requested' && outcome.effectNotSent) {
        await moveStep(deps, tx, step, 'cancelled', 'cancel_requested');
        await graph.finishCancel(tx, run);
        released = run;
        return;
      }
      if (run.status === 'cancel_requested' || BOT_RUN_TERMINAL.has(run.status)) {
        await event(deps, tx, run.task_id, 'late_result_ignored');
        await lease.delay(tx, job);
        return;
      }
      const denial = await recheck(options, run);
      if (
        denial &&
        step.kind === 'mcp_delegate' &&
        step.idempotency_key &&
        !outcome.effectNotSent
      ) {
        await lease.delay(tx, job);
        return;
      }
      await accepted(tx, run, step, denial ? { status: 'failed', code: denial } : outcome);
      released = run;
    });
    if (released) await graph.release(released);
  };
}
