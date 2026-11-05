import { BOT_RUN_TERMINAL, BOT_STEP_TERMINAL } from '@agent-works/domain';
import * as z from 'zod';

import { reservePaid } from './cost.js';
import { recheck } from './recheck.js';
import { createApproval, inputFor, loadRun, moveRun, moveStep, stepsFor } from './store.js';

import type { createBotGraph } from './graph.js';
import type { createBotLease } from './lease.js';
import type { BotJob, ExecutionOptions, RunRow, StepRow } from './types.js';
import type { Tx } from '../../context.js';
import type { BotStep } from '@agent-works/domain';

export type PreparedStep = { run: RunRow; step: StepRow; definition: BotStep; fresh: boolean };
function externalEffect(step: StepRow) {
  return step.kind === 'mcp_delegate' && step.status !== 'ready';
}
export function createBotPreparation(
  options: ExecutionOptions,
  lease: ReturnType<typeof createBotLease>,
  graph: ReturnType<typeof createBotGraph>,
) {
  const { deps } = options;
  async function checkpoint(
    tx: Tx,
    run: RunRow,
    step: StepRow,
    definition: Extract<BotStep, { kind: 'approval' }>,
  ) {
    await createApproval(deps, tx, run, step.step_id, definition.prompt);
    await moveStep(deps, tx, step, 'waiting_approval');
    await moveRun(deps, tx, run, 'waiting_approval');
  }
  async function startStep(tx: Tx, job: BotJob, run: RunRow, step: StepRow, definition: BotStep) {
    if (run.status !== 'running') await moveRun(deps, tx, run, 'running');
    if (definition.kind === 'approval') {
      await checkpoint(tx, run, step, definition);
      return false;
    }
    if (step.kind === 'skill' || step.kind === 'mcp_delegate')
      await reservePaid(options, tx, run, step);
    await moveStep(deps, tx, step, 'running');
    step.input = inputFor(run, step.step_id, await stepsFor(tx, run.task_id));
    step.idempotency_key =
      step.kind === 'mcp_delegate' ? `bot:${run.task_id}:${step.step_id}:${step.attempt}` : null;
    if (definition.kind === 'mcp_delegate')
      step.external = {
        agentId: definition.agent.agentId,
        handle: null,
        lastStatus: 'submitting',
        cancel: 'not_requested',
      };
    step.started_at ??= deps.now();
    await tx`update tw_bot_steps set input=${tx.json(z.json().parse(step.input))}, idempotency_key=${step.idempotency_key},external=${step.external ? tx.json(step.external) : null},
      started_at=coalesce(started_at,${deps.now()}) where task_id=${run.task_id} and step_id=${step.step_id} and owner_token=${job.lease_token}`;
    return true;
  }
  async function refuse(tx: Tx, run: RunRow, step: StepRow, denial: string) {
    if (step.status === 'ready') await moveStep(deps, tx, step, 'running');
    await moveStep(deps, tx, step, 'failed', denial);
    await graph.advance(tx, run);
  }
  async function prepareOwned(
    tx: Tx,
    job: BotJob,
    run: RunRow,
    step: StepRow,
  ): Promise<PreparedStep | undefined> {
    if (BOT_STEP_TERMINAL.has(step.status) || BOT_RUN_TERMINAL.has(run.status)) return;
    if (['pending', 'waiting_approval'].includes(step.status)) return;
    if (run.status === 'waiting_approval') return;
    const definition = run.definition.workflow.steps.find((s) => s.id === step.step_id);
    if (!definition) throw new Error('missing_step');
    const fresh = step.status === 'ready';
    await tx`update tw_bot_steps set owner_token=${job.lease_token} where task_id=${run.task_id} and step_id=${step.step_id}`;
    step.owner_token = job.lease_token;
    const denial = await recheck(options, run);
    if (denial && !externalEffect(step) && run.status !== 'cancel_requested') {
      await refuse(tx, run, step, denial);
      return;
    }
    if (fresh && !denial) {
      const started = await startStep(tx, job, run, step, definition);
      if (!started) return;
    }
    return { run, step, definition, fresh };
  }
  return async (job: BotJob) => {
    let prepared: PreparedStep | undefined;
    await deps.sql.begin(async (tx) => {
      const state = await lease.owned(tx, job);
      if (state) prepared = await prepareOwned(tx, job, state.run, state.step);
    });
    if (!prepared && job.task_id) {
      const run = await loadRun(deps.sql, job.task_id);
      if (run) await graph.release(run);
    }
    return prepared;
  };
}
