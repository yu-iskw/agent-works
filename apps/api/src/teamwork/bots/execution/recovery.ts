import { BOT_RUN_TERMINAL } from '@agent-works/domain';

import { recheck } from './recheck.js';
import { approvalsFor, loadRun, moveRun, moveStep, queueStep, stepsFor } from './store.js';

import type { createBotExecution } from './engine.js';
import type { ExecutionOptions, RunRow, StepRow } from './types.js';
import type { Tx } from '../../context.js';

export function createBotRecovery(
  options: ExecutionOptions,
  execution: ReturnType<typeof createBotExecution>,
) {
  const { deps } = options;
  async function deny(tx: Tx, run: RunRow, steps: StepRow[], denial: string | null) {
    const code = denial ?? 'approval_expired';
    for (const step of steps.filter((s) =>
      ['pending', 'ready', 'waiting_approval'].includes(s.status),
    ))
      await moveStep(deps, tx, step, 'blocked', code);
    if (!steps.some((s) => s.status === 'running' || s.status === 'waiting_external'))
      await moveRun(deps, tx, run, 'failed', code);
  }
  return async () => {
    const expired = new Set(await options.admission.sweepExpired());
    const rows = await deps.sql<
      { task_id: string }[]
    >`select r.task_id from tw_bot_runs r join wb_tasks t on t.id = r.task_id
      where t.status in ('queued','running','waiting_external','waiting_approval','cancel_requested')`;
    for (const { task_id: taskId } of rows) {
      await deps.sql.begin(async (tx) => {
        const run = await loadRun(tx, taskId, true);
        if (!run || BOT_RUN_TERMINAL.has(run.status)) return;
        const steps = await stepsFor(tx, taskId);
        const denial = expired.has(taskId) ? 'admission_expired' : await recheck(options, run);
        const approvalExpired = (await approvalsFor(tx, taskId)).some(
          (a) => a.state === 'pending' && a.expires_at <= deps.now(),
        );
        if (approvalExpired || (denial && denial !== 'cancel_requested'))
          await deny(tx, run, steps, denial);
        const external = steps.find(
          (s) => s.status === 'waiting_external' || s.status === 'running',
        );
        if (external) await queueStep(deps, tx, taskId, external.step_id);
        else if (run.status === 'running') await execution.advance(tx, run);
        else if (run.status === 'cancel_requested') await execution.finishCancel(tx, run);
      });
      const run = await loadRun(deps.sql, taskId);
      if (run) {
        if (BOT_RUN_TERMINAL.has(run.status)) await execution.release(run);
        else if (!expired.has(taskId)) await options.admission.renew(taskId);
      }
    }
    return rows.length;
  };
}
