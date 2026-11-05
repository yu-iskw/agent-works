import { randomUUID } from 'node:crypto';

import { BOT_RUN_TERMINAL, botRunStatusSchema } from '@agent-works/domain';

import { Conflict } from '../../context.js';

import { grantValid, recheck } from './recheck.js';
import { createApproval, event, loadRun, moveRun, queueStep } from './store.js';

import type { ExecutionOptions, RunRow } from './types.js';
import type { Tx } from '../../context.js';

export type BotTrigger =
  | { kind: 'manual' }
  | { kind: 'schedule'; ref: string; scheduledFor: string }
  | { kind: 'event'; ref: string; source: string; eventType: string; payload: unknown };
export type StartBotRunInput = {
  teammateId: string;
  trigger: BotTrigger;
  initiatedBy: string;
  clientRequestId: string;
  /**
   * The revision whose trigger declaration matched (schedule and event starts always set it).
   * Checked under the same row lock publication takes, so a publish in between cannot run a newer
   * revision for a trigger matched against an older one.
   */
  expectedRevision?: number;
};
export type StartBotRunResult =
  | { kind: 'started'; taskId: string; revision: number; digest: string }
  | { kind: 'duplicate'; taskId: string }
  | { kind: 'denied'; code: string }
  | {
      kind: 'deferred';
      code: 'bot_cap' | 'member_cap' | 'segment_cap' | 'cost_budget';
      retryAfterMs?: number;
    };
export type StartBotRun = (input: StartBotRunInput) => Promise<StartBotRunResult>;
async function assertAuthority(options: ExecutionOptions, run: RunRow) {
  const denied = await recheck(options, run);
  if (denied) throw new Conflict(denied, 403);
}
function triggerDeclared(run: RunRow, trigger: BotTrigger) {
  return run.definition.triggers.some(
    (t) =>
      t.kind === trigger.kind &&
      (t.kind !== 'event' ||
        (trigger.kind === 'event' &&
          t.source === trigger.source &&
          t.eventType === trigger.eventType)),
  );
}
async function pinnedRun(options: ExecutionOptions, input: StartBotRunInput): Promise<RunRow> {
  const { deps } = options;
  const owner = (
    await deps.sql<
      { owner_sub: string; owner_email: string | null }[]
    >`select owner_sub,owner_email from tw_bots where teammate_id=${input.teammateId}`
  ).at(0);
  if (!owner) throw new Conflict('no_published_revision');
  if (input.trigger.kind === 'manual' && input.initiatedBy !== owner.owner_sub)
    throw new Conflict('bot_not_shared', 403);
  if (!owner.owner_email) throw new Conflict('identity_unbound', 403);
  let pin;
  try {
    pin = await options.service.pinForRun(input.teammateId);
  } catch (error) {
    if (error instanceof Conflict) throw new Conflict('no_published_revision');
    throw error;
  }
  const now = deps.now();
  const run: RunRow = {
    task_id: randomUUID(),
    teammate_id: input.teammateId,
    ...pin,
    owner_sub: owner.owner_sub,
    owner_email: owner.owner_email,
    execution_sub: owner.owner_sub,
    initiated_by: input.initiatedBy,
    trigger_kind: input.trigger.kind,
    trigger_ref:
      input.trigger.kind === 'manual' ? `manual:${input.clientRequestId}` : input.trigger.ref,
    approval_mode: pin.definition.approvals.mode,
    grant_id: null,
    status: 'queued',
    result_text: null,
    error_code: null,
    created_at: now,
    started_at: null,
    finished_at: null,
    deadline_at: new Date(now.getTime() + pin.definition.limits.runTimeoutMinutes * 60_000),
  };
  if (!triggerDeclared(run, input.trigger)) throw new Conflict('trigger_not_declared', 403);
  return run;
}
async function chooseGrant(options: ExecutionOptions, run: RunRow) {
  if (run.approval_mode !== 'standing_grant') return;
  for (const grant of await options.grants.list({ sponsor: run.owner_sub })) {
    if (await grantValid(options, run, grant, true)) {
      run.grant_id = grant.grantId;
      return;
    }
  }
  throw new Conflict('grant_invalid', 403);
}
async function admit(
  options: ExecutionOptions,
  run: RunRow,
  input: StartBotRunInput,
): Promise<StartBotRunResult | undefined> {
  // Deployment admission policy is applied as configured and never rewritten from a definition;
  // the definition's own ceilings narrow it inside commitRun (T7-02).
  const result = await options.admission.admit({
    executionId: run.task_id,
    botId: run.teammate_id,
    memberId: run.owner_sub,
    segmentId: options.deps.config.segment,
    windowKey: run.created_at.toISOString().slice(0, 10),
    estimatedCostMicros: 0,
  });
  if (result.admitted) return;
  const code = ['bot_cap', 'segment_cap', 'cost_budget'].find((c) => c === result.reason);
  if (input.trigger.kind === 'manual') return { kind: 'denied', code: 'admission_denied' };
  if (code === 'bot_cap' || code === 'segment_cap' || code === 'cost_budget')
    return { kind: 'deferred', code };
  return { kind: 'deferred', code: 'member_cap' };
}
async function insertRun(options: ExecutionOptions, tx: Tx, run: RunRow, input: StartBotRunInput) {
  const { deps } = options;
  await tx`insert into wb_tasks(id,owner_sub,owner_email,client_request_id,title,objective,status,version,llm_mode,model_id,created_at,updated_at,kind,segment,result_owner)
    values(${run.task_id},${run.owner_sub},${run.owner_email},${input.clientRequestId},${run.definition.name},${run.definition.purpose},'queued',1,${deps.gate.mode},${deps.gate.modelId},${run.created_at},${run.created_at},'bot',${deps.config.segment},${run.teammate_id})`;
  await tx`insert into tw_bot_runs(task_id,teammate_id,revision,digest,trigger_kind,trigger_ref,owner_sub,initiated_by,execution_sub,approval_mode,grant_id,created_at,updated_at,deadline_at)
    values(${run.task_id},${run.teammate_id},${run.revision},${run.digest},${run.trigger_kind},${run.trigger_ref},${run.owner_sub},${run.initiated_by},${run.execution_sub},${run.approval_mode},${run.grant_id},${run.created_at},${run.created_at},${run.deadline_at})`;
  for (const step of run.definition.workflow.steps)
    await tx`insert into tw_bot_steps(task_id,step_id,kind,status,depends_on,created_at,updated_at)
    values(${run.task_id},${step.id},${step.kind},${step.dependsOn.length ? 'pending' : 'ready'},${tx.json(step.dependsOn)},${run.created_at},${run.created_at})`;
  await event(deps, tx, run.task_id, 'created');
  if (run.approval_mode === 'per_run') {
    await createApproval(deps, tx, run, null, 'Approve this bot run and its pinned authority.');
    await moveRun(deps, tx, run, 'waiting_approval');
  } else {
    await moveRun(deps, tx, run, 'running');
    const root = run.definition.workflow.steps.find((s) => !s.dependsOn.length);
    if (root) await queueStep(deps, tx, run.task_id, root.id);
  }
}
const ACTIVE_RUN_STATUSES = botRunStatusSchema.options.filter(
  (status) => !BOT_RUN_TERMINAL.has(status),
);
/**
 * The definition's concurrency ceilings, checked inside the transaction that inserts the run: the
 * bot row lock (taken first) serializes starts of one bot and the owner lock those of one owner,
 * so counts cannot race. They can only narrow the deployment's admission policy.
 */
export async function definitionCeiling(
  tx: Tx,
  run: RunRow,
): Promise<'bot_cap' | 'member_cap' | undefined> {
  // Lock order everywhere: the bot row, then the owner. A caller may already hold the bot row.
  await tx`select 1 from tw_bots where teammate_id = ${run.teammate_id} for update`;
  await tx`select pg_advisory_xact_lock(7035, hashtext(${run.owner_sub}))`;
  const [counts] = await tx<{ bot: number; member: number }[]>`
    select count(*) filter (where r.teammate_id = ${run.teammate_id})::int as bot,
      count(*)::int as member
    from tw_bot_runs r join wb_tasks t on t.id = r.task_id
    where r.owner_sub = ${run.owner_sub} and t.status in ${tx(ACTIVE_RUN_STATUSES)}
  `;
  const { maxConcurrentRunsPerBot, maxConcurrentRunsPerUser } = run.definition.limits;
  if (counts.bot >= maxConcurrentRunsPerBot) return 'bot_cap';
  if (counts.member >= maxConcurrentRunsPerUser) return 'member_cap';
  return undefined;
}
async function commitRun(
  options: ExecutionOptions,
  run: RunRow,
  input: StartBotRunInput,
): Promise<StartBotRunResult> {
  const { deps } = options;
  let result: StartBotRunResult = {
    kind: 'started',
    taskId: run.task_id,
    revision: run.revision,
    digest: run.digest,
  };
  await deps.sql.begin(async (tx) => {
    const locked = await tx<
      { active_revision: number | null }[]
    >`select active_revision from tw_bots where teammate_id=${run.teammate_id} for update`;
    const active = locked.at(0)?.active_revision ?? null;
    if (
      active !== run.revision ||
      (input.expectedRevision !== undefined && active !== input.expectedRevision)
    ) {
      result = { kind: 'denied', code: 'revision_changed' };
      return;
    }
    const duplicate = (
      await tx<
        { task_id: string }[]
      >`select task_id from tw_bot_runs where teammate_id=${run.teammate_id} and trigger_ref=${run.trigger_ref}`
    ).at(0);
    if (duplicate) {
      result = { kind: 'duplicate', taskId: duplicate.task_id };
      return;
    }
    const ceiling = await definitionCeiling(tx, run);
    if (ceiling) {
      result =
        input.trigger.kind === 'manual'
          ? { kind: 'denied', code: 'admission_denied' }
          : { kind: 'deferred', code: ceiling };
      return;
    }
    if (run.grant_id) {
      await tx`select 1 from tw_standing_grants where grant_id=${run.grant_id} for update`;
      const grant = await options.grants.get(run.grant_id);
      if (!grant || !(await grantValid(options, run, grant, true)))
        throw new Conflict('grant_invalid', 403);
    }
    await assertAuthority(options, run);
    await insertRun(options, tx, run, input);
  });
  if (!(await loadRun(deps.sql, run.task_id)))
    await options.admission.release(run.task_id, 'cancelled');
  return result;
}
export function createStartBotRun(options: ExecutionOptions): StartBotRun {
  const start: StartBotRun = async (input) => {
    let reserved: RunRow | undefined;
    try {
      const run = await pinnedRun(options, input);
      const duplicate = (
        await options.deps.sql<
          { task_id: string }[]
        >`select task_id from tw_bot_runs where teammate_id=${run.teammate_id} and trigger_ref=${run.trigger_ref}`
      ).at(0);
      if (duplicate) return { kind: 'duplicate', taskId: duplicate.task_id };
      await chooseGrant(options, run);
      await assertAuthority(options, run);
      const denial = await admit(options, run, input);
      if (denial) return denial;
      reserved = run;
      return await commitRun(options, run, input);
    } catch (error) {
      if (reserved) await options.admission.release(reserved.task_id, 'cancelled');
      if (error instanceof Conflict) return { kind: 'denied', code: error.code };
      throw error;
    }
  };
  return (input) =>
    options.deps.sql.begin(async (tx) => {
      await tx`select pg_advisory_xact_lock(7033,hashtext(${input.teammateId}))`;
      return start(input);
    });
}
