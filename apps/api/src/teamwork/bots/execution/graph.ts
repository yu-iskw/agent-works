import { BOT_RUN_TERMINAL } from '@agent-works/domain';

import { costView } from './cost.js';
import { moveRun, moveStep, queueStep, stepsFor } from './store.js';

import type { ExecutionOptions, RunRow, StepRow } from './types.js';
import type { Tx } from '../../context.js';

function missingOutput(run: RunRow, step: StepRow, steps: readonly StepRow[]) {
  const definition = run.definition.workflow.steps.find((s) => s.id === step.step_id);
  if (!definition) throw new Error('missing_step');
  const refs =
    'inputs' in definition
      ? definition.inputs
      : definition.kind === 'result'
        ? [definition.from]
        : [];
  return refs.some((id) => steps.find((s) => s.step_id === id)?.output === null);
}
export function createBotGraph(options: ExecutionOptions) {
  const { deps } = options;
  async function release(run: RunRow) {
    if (!BOT_RUN_TERMINAL.has(run.status)) return;
    const cost = await costView(deps.sql, run.task_id, await stepsFor(deps.sql, run.task_id));
    await deps.sql`update tw_bot_runs set cost = ${deps.sql.json(cost)} where task_id = ${run.task_id}`;
    const outcome =
      run.status === 'completed'
        ? 'succeeded'
        : run.status === 'cancelled'
          ? 'cancelled'
          : 'failed';
    await options.admission.release(run.task_id, outcome, cost.reportedMicros ?? undefined);
  }
  async function releaseDependencies(tx: Tx, run: RunRow, steps: StepRow[]) {
    for (const step of steps.filter((s) => s.status === 'pending')) {
      const definition = run.definition.workflow.steps.find((s) => s.id === step.step_id);
      const ready = definition?.dependsOn.every(
        (id) => steps.find((s) => s.step_id === id)?.status === 'succeeded',
      );
      if (!ready) continue;
      if (missingOutput(run, step, steps))
        await moveStep(deps, tx, step, 'blocked', 'resolved_without_output');
      else await moveStep(deps, tx, step, 'ready');
    }
  }
  async function failGraph(tx: Tx, run: RunRow, steps: StepRow[], failed: StepRow) {
    for (const step of steps.filter((s) => ['pending', 'ready'].includes(s.status)))
      await moveStep(deps, tx, step, 'blocked', 'dependency_failed');
    if (!BOT_RUN_TERMINAL.has(run.status))
      await moveRun(
        deps,
        tx,
        run,
        failed.status === 'outcome_uncertain' ? 'outcome_uncertain' : 'failed',
        failed.error_code,
      );
  }
  async function chooseNext(tx: Tx, run: RunRow, steps: StepRow[]) {
    const ready = steps.find((s) => s.status === 'ready');
    if (ready) {
      if (run.status !== 'running') await moveRun(deps, tx, run, 'running');
      await queueStep(deps, tx, run.task_id, ready.step_id);
      return;
    }
    const next = steps.some((s) => s.status === 'waiting_external')
      ? 'waiting_external'
      : 'waiting_approval';
    if (run.status !== next) await moveRun(deps, tx, run, next);
  }
  async function advance(tx: Tx, run: RunRow) {
    const steps = await stepsFor(tx, run.task_id);
    const failed = steps.find((s) => ['failed', 'outcome_uncertain'].includes(s.status));
    if (failed) {
      await failGraph(tx, run, steps, failed);
      return;
    }
    await releaseDependencies(tx, run, steps);
    if (steps.some((s) => s.status === 'blocked')) {
      if (!BOT_RUN_TERMINAL.has(run.status))
        await moveRun(deps, tx, run, 'failed', 'resolved_without_output');
      return;
    }
    await chooseNext(tx, run, steps);
  }
  async function finishCancel(tx: Tx, run: RunRow) {
    const steps = await stepsFor(tx, run.task_id);
    if (steps.some((s) => s.status === 'running' || s.status === 'waiting_external')) return;
    if (run.status === 'cancel_requested')
      await moveRun(
        deps,
        tx,
        run,
        steps.some((s) => s.status === 'outcome_uncertain') ? 'outcome_uncertain' : 'cancelled',
      );
  }
  return { release, advance, finishCancel };
}
