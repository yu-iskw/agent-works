import { BOT_STEP_TERMINAL } from '@agent-works/domain';

import { loadRun, stepsFor } from './store.js';

import type { BotJob, ExecutionOptions, RunRow, StepRow } from './types.js';
import type { Tx } from '../../context.js';

export function createBotLease(options: ExecutionOptions) {
  const { deps } = options;
  const pollMs = options.pollMs ?? 2000;
  async function owned(
    tx: Tx,
    job: BotJob,
    settling = false,
  ): Promise<{ run: RunRow; step: StepRow } | undefined> {
    if (!job.task_id) return;
    const run = await loadRun(tx, job.task_id, true);
    if (!run) return;
    const valid =
      await tx`select 1 from tw_jobs where id = ${job.id} and lease_token = ${job.lease_token} and state = 'running' and lease_until > now()`;
    if (!valid.length) return;
    const step = (await stepsFor(tx, run.task_id)).find(
      (s) => `${run.task_id}:${s.step_id}` === job.ref,
    );
    if (!step) return;
    if (settling && (step.owner_token !== job.lease_token || BOT_STEP_TERMINAL.has(step.status)))
      return;
    return { run, step };
  }
  async function delay(tx: Tx, job: BotJob) {
    await tx`update tw_jobs set state = 'queued', attempts = 0, run_after = ${new Date(deps.now().getTime() + pollMs)}, lease_until = null,
      updated_at = ${deps.now()} where id = ${job.id} and lease_token = ${job.lease_token} and state = 'running'`;
  }
  return { owned, delay };
}
