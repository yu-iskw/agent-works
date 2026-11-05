import {
  BOT_RUN_TERMINAL,
  BOT_STEP_TERMINAL,
  canTransition,
  canonicalPayloadSha256,
  stepDataInputs,
} from '@agent-works/domain';

import { appendEvent } from '../../store.js';

import { ADMIN_TRANSITIONS } from './types.js';

import type { ApprovalRow, Db, RunRow, StepRow } from './types.js';
import type { Deps, Tx } from '../../context.js';
import type { BotRunStatus, BotStep, BotStepStatus } from '@agent-works/domain';

export async function loadRun(db: Db, taskId: string, lock = false): Promise<RunRow | undefined> {
  return (
    await db<RunRow[]>`
    select r.*, t.status, t.owner_email, t.error_code, v.definition
    from tw_bot_runs r join wb_tasks t on t.id = r.task_id
    join tw_bot_revisions v on v.teammate_id = r.teammate_id and v.revision = r.revision
    where r.task_id = ${taskId} ${lock ? db`for update of r, t` : db``}
  `
  ).at(0);
}
export async function stepsFor(db: Db, taskId: string): Promise<StepRow[]> {
  return db<
    StepRow[]
  >`select * from tw_bot_steps where task_id = ${taskId} order by created_at, step_id`;
}
export async function approvalsFor(db: Db, taskId: string): Promise<ApprovalRow[]> {
  return db<
    ApprovalRow[]
  >`select * from wb_approvals where task_id = ${taskId} order by requested_at, id`;
}
export async function event(deps: Deps, tx: Tx, taskId: string, code: string): Promise<void> {
  await appendEvent(deps, tx, taskId, { type: `bot.${code}`, summary: code });
}
async function inbox(
  deps: Deps,
  tx: Tx,
  run: RunRow,
  kind: 'approval' | 'completed' | 'failed' | 'uncertain',
  ref: string,
): Promise<void> {
  await tx`insert into tw_inbox (id, owner_sub, task_id, kind, ref, summary, state, created_at)
    values (${deps.newId()}, ${run.owner_sub}, ${run.task_id}, ${kind}, ${ref}, ${`Bot run ${kind}`}, 'open', ${deps.now()})
    on conflict (task_id, ref) do update set state = 'open', summary = excluded.summary`;
}
export async function moveRun(
  deps: Deps,
  tx: Tx,
  run: RunRow,
  status: BotRunStatus,
  code: string | null = null,
): Promise<void> {
  if (status === run.status) return;
  if (!canTransition('run', run.status, status)) throw new Error('invalid_run_transition');
  await applyRunMove(deps, tx, run, status, code);
}
/**
 * An owner's administrative move out of a terminal state (retry, resolve), allowed only by
 * ADMIN_TRANSITIONS. It records the same event, version and inbox changes as a normal move, and a
 * reopened run's terminal inbox item is resolved (CR-08).
 */
export async function moveRunAdmin(
  deps: Deps,
  tx: Tx,
  run: RunRow,
  status: BotRunStatus,
  code: string | null = null,
): Promise<void> {
  const allowed: Partial<Record<BotRunStatus, readonly BotRunStatus[]>> = ADMIN_TRANSITIONS.run;
  // eslint-disable-next-line security/detect-object-injection -- run.status is a closed union
  if (!allowed[run.status]?.includes(status)) throw new Error('invalid_run_transition');
  if (!BOT_RUN_TERMINAL.has(status))
    await tx`update tw_inbox set state = 'resolved', resolved_at = ${deps.now()} where task_id = ${run.task_id} and state = 'open' and ref like 'run:%'`;
  await applyRunMove(deps, tx, run, status, code);
}
async function applyRunMove(
  deps: Deps,
  tx: Tx,
  run: RunRow,
  status: BotRunStatus,
  code: string | null,
): Promise<void> {
  await tx`update wb_tasks set status = ${status}, error_code = ${code}, error_message = ${code}, updated_at = ${deps.now()}, version = version + 1 where id = ${run.task_id}`;
  await tx`update tw_bot_runs set updated_at = ${deps.now()}, started_at = coalesce(started_at, ${deps.now()}),
    finished_at = ${BOT_RUN_TERMINAL.has(status) ? deps.now() : null} where task_id = ${run.task_id}`;
  run.status = status;
  run.error_code = code;
  await event(deps, tx, run.task_id, status);
  if (BOT_RUN_TERMINAL.has(status)) {
    await tx`update wb_approvals set state = 'void' where task_id = ${run.task_id} and state = 'pending'`;
    await tx`update tw_inbox set state = 'resolved', resolved_at = ${deps.now()} where task_id = ${run.task_id} and state = 'open'`;
    if (status !== 'cancelled')
      await inbox(deps, tx, run, terminalInboxKind(status), `run:${status}`);
  }
}
export async function moveStep(
  deps: Deps,
  tx: Tx,
  step: StepRow,
  status: BotStepStatus,
  code: string | null = null,
): Promise<void> {
  if (!canTransition('step', step.status, status)) throw new Error('invalid_step_transition');
  await tx`update tw_bot_steps set status = ${status}, error_code = ${code}, terminal_reason = ${code}, updated_at = ${deps.now()},
    finished_at = ${BOT_STEP_TERMINAL.has(status) ? deps.now() : null}
    where task_id = ${step.task_id} and step_id = ${step.step_id} and status = ${step.status}`;
  step.status = status;
  step.error_code = code;
}
export async function queueStep(deps: Deps, tx: Tx, taskId: string, stepId: string): Promise<void> {
  await tx`insert into tw_jobs (task_id, kind, ref, state, created_at, updated_at)
    values (${taskId}, 'bot_step', ${`${taskId}:${stepId}`}, 'queued', ${deps.now()}, ${deps.now()})
    on conflict (kind, ref) where state in ('queued','running') do nothing`;
}
export function runDigest(
  run: Pick<RunRow, 'task_id' | 'revision' | 'digest' | 'definition'>,
): string {
  return canonicalPayloadSha256({
    taskId: run.task_id,
    revision: run.revision,
    digest: run.digest,
    capabilities: capabilities(run.definition),
    agents: run.definition.workflow.steps
      .filter((s) => s.kind === 'mcp_delegate')
      .map((s) => s.agent.agentId)
      .sort(),
  });
}
export function capabilities(definition: RunRow['definition']) {
  return [
    ...new Set(
      definition.workflow.steps.filter((s) => s.kind === 'connector_read').map((s) => s.capability),
    ),
  ].sort();
}
function inputRefs(step: BotStep): readonly string[] {
  return 'inputs' in step ? step.inputs : step.kind === 'result' ? [step.from] : step.dependsOn;
}
export function inputFor(run: RunRow, stepId: string, steps: readonly StepRow[]): unknown {
  const step = run.definition.workflow.steps.find((s) => s.id === stepId);
  if (!step) throw new Error('missing_step');
  return Object.fromEntries(
    inputRefs(step).map((id) => [id, steps.find((s) => s.step_id === id)?.output ?? null]),
  );
}
/**
 * A checkpoint binds the task, revision digest, the definitions of the steps that directly follow
 * it and the exact data those steps will use. Validation guarantees that data is produced upstream
 * of the checkpoint, so it has settled when the checkpoint is created and cannot change before the
 * steps run (T7-03, T8-01, T8-03).
 */
export function checkpointDigest(run: RunRow, stepId: string, steps: readonly StepRow[]): string {
  const byId = new Map(run.definition.workflow.steps.map((s) => [s.id, s]));
  return canonicalPayloadSha256({
    taskId: run.task_id,
    stepId,
    digest: run.digest,
    next: run.definition.workflow.steps
      .filter((s) => s.dependsOn.includes(stepId))
      .map((s) => ({
        step: s,
        input: Object.fromEntries(
          stepDataInputs(s, byId).map((id) => [
            id,
            steps.find((row) => row.step_id === id)?.output ?? null,
          ]),
        ),
      })),
  });
}
export async function createApproval(
  deps: Deps,
  tx: Tx,
  run: RunRow,
  stepId: string | null,
  prompt: string,
): Promise<void> {
  const steps = await stepsFor(tx, run.task_id);
  const id = deps.newId();
  const digest = stepId === null ? runDigest(run) : checkpointDigest(run, stepId, steps);
  await tx`insert into wb_approvals (id, task_id, subject, subject_ref, step_id, proposal, document, payload_sha256, state, requested_at, expires_at)
    values (${id}, ${run.task_id}, ${stepId === null ? 'bot_run' : 'bot_checkpoint'}, ${run.revision}, ${stepId}, ${tx.json({ prompt })}, '{}'::jsonb,
    ${digest}, 'pending', ${deps.now()}, ${run.deadline_at})`;
  await inbox(deps, tx, run, 'approval', id);
}

function terminalInboxKind(status: BotRunStatus) {
  if (status === 'completed') return 'completed' as const;
  return status === 'outcome_uncertain' ? ('uncertain' as const) : ('failed' as const);
}
