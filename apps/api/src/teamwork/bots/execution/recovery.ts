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
  /**
   * A lease that lapsed while the run was still live (process down, worker busy) is re-admitted:
   * the run keeps its place unless the capacity has since gone to other work (CR-05).
   */
  async function readmit(run: RunRow): Promise<boolean> {
    const result = await options.admission.admit({
      executionId: run.task_id,
      botId: run.teammate_id,
      memberId: run.owner_sub,
      segmentId: deps.config.segment,
      windowKey: run.created_at.toISOString().slice(0, 10),
      estimatedCostMicros: 0,
    });
    return result.admitted;
  }
  async function recoverRun(taskId: string, swept: boolean) {
    const before = await loadRun(deps.sql, taskId);
    if (!before || BOT_RUN_TERMINAL.has(before.status)) return;
    const lapsed = swept && !(await readmit(before));
    await deps.sql.begin(async (tx) => {
      const run = await loadRun(tx, taskId, true);
      if (!run || BOT_RUN_TERMINAL.has(run.status)) return;
      const steps = await stepsFor(tx, taskId);
      const denial = lapsed ? 'admission_expired' : await recheck(options, run);
      const approvalExpired = (await approvalsFor(tx, taskId)).some(
        (a) => a.state === 'pending' && a.expires_at <= deps.now(),
      );
      if (approvalExpired || (denial && denial !== 'cancel_requested'))
        await deny(tx, run, steps, denial);
      const external = steps.find((s) => s.status === 'waiting_external' || s.status === 'running');
      if (external) await queueStep(deps, tx, taskId, external.step_id);
      else if (run.status === 'running') await execution.advance(tx, run);
      else if (run.status === 'cancel_requested') await execution.finishCancel(tx, run);
    });
    const run = await loadRun(deps.sql, taskId);
    if (run) {
      if (BOT_RUN_TERMINAL.has(run.status)) await execution.release(run);
      else if (!lapsed) await options.admission.renew(taskId);
    }
  }
  return async () => {
    const expired = new Set(await options.admission.sweepExpired());
    const rows = await deps.sql<
      { task_id: string }[]
    >`select r.task_id from tw_bot_runs r join wb_tasks t on t.id = r.task_id
      where t.status in ('queued','running','waiting_external','waiting_approval','cancel_requested')`;
    for (const { task_id: taskId } of rows)
      try {
        await recoverRun(taskId, expired.has(taskId));
      } catch (error) {
        // One run's failure must not stop lease renewal for the others (CR-05).
        console.error(
          JSON.stringify({
            level: 'error',
            component: 'bot-recovery',
            taskId,
            error: error instanceof Error ? error.name : 'unknown',
          }),
        );
      }
    return rows.length;
  };
}
