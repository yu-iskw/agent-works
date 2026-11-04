import { Conflict } from '../../context.js';

import type { Db, ExecutionOptions, RunRow, StepRow } from './types.js';

export async function costView(db: Db, taskId: string, steps: readonly StepRow[]) {
  const calls = await db<
    { id: number }[]
  >`select id from wb_model_calls where task_id = ${taskId} and sent`;
  const unknownItems = calls.map((c) => `model:${c.id}:price_unavailable`);
  if (calls.length === 0)
    for (const step of steps.filter(
      (s) => s.kind === 'skill' && s.status === 'running' && s.cost?.basis === 'unknown',
    ))
      unknownItems.push(`model:${step.step_id}:${step.attempt}:dispatch_pending`);
  let reportedMicros: number | null = null;
  const items = steps
    .filter((s) => s.kind === 'mcp_delegate')
    .flatMap((s) => [
      ...s.cost_history.map((p) => ({ key: `mcp:${s.step_id}:${p.attempt}`, cost: p.cost })),
      ...(s.idempotency_key ? [{ key: `mcp:${s.step_id}:${s.attempt}`, cost: s.cost }] : []),
    ]);
  for (const item of items) {
    if (item.cost?.basis === 'reported')
      reportedMicros = (reportedMicros ?? 0) + item.cost.amountMicros;
    else unknownItems.push(item.key);
  }
  return {
    completeness:
      unknownItems.length === 0
        ? ('complete' as const)
        : reportedMicros !== null
          ? ('partial' as const)
          : ('unknown' as const),
    estimatedMicros: null,
    reportedMicros,
    unknownItems,
  };
}

export async function reservePaid(
  options: ExecutionOptions,
  tx: Db,
  run: RunRow,
  step: StepRow,
): Promise<void> {
  const steps = await tx<StepRow[]>`select * from tw_bot_steps where task_id = ${run.task_id}`;
  const cost = await costView(tx, run.task_id, steps);
  let ceiling = run.definition.limits.maxCostMicros;
  let grantSpent = 0;
  if (run.grant_id) {
    await tx`select 1 from tw_standing_grants where grant_id=${run.grant_id} for update`;
    const grant = await options.grants.get(run.grant_id);
    if (!grant) throw new Conflict('grant_invalid', 403);
    if (grant.limits.budget.estimatedCostMicros !== Number.MAX_SAFE_INTEGER)
      ceiling = Math.min(
        ceiling ?? Number.MAX_SAFE_INTEGER,
        grant.limits.budget.estimatedCostMicros,
      );
    const others = await tx<
      { task_id: string }[]
    >`select task_id from tw_bot_runs where grant_id=${run.grant_id} and task_id<>${run.task_id}`;
    const totals = await Promise.all(
      others.map(async (other) => ({
        cost: await costView(
          tx,
          other.task_id,
          await tx<StepRow[]>`select * from tw_bot_steps where task_id=${other.task_id}`,
        ),
      })),
    );
    if (ceiling !== null && totals.some((r) => r.cost.unknownItems.length > 0))
      throw new Conflict('cost_budget');
    grantSpent = totals.reduce((n, r) => n + (r.cost.reportedMicros ?? 0), 0);
  }
  if (
    ceiling !== null &&
    (steps.some(
      (s) => s.kind === 'skill' && s.cost?.basis === 'unknown' && s.step_id !== step.step_id,
    ) ||
      cost.unknownItems.length > 0 ||
      (cost.reportedMicros ?? 0) + grantSpent >= ceiling)
  )
    throw new Conflict('cost_budget');
  // Without an approved price or agent quote, one unknown item consumes the available budget.
  await tx`update tw_bot_steps set cost = '{"basis":"unknown"}'::jsonb where task_id = ${run.task_id} and step_id = ${step.step_id}`;
}
