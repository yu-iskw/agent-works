import { BOT_RUN_TERMINAL, BOT_STEP_OPEN } from '@agent-works/domain';

import { audit, Conflict } from '../../context.js';

import { recheck } from './recheck.js';
import { definitionCeiling } from './start.js';
import {
  approvalsFor,
  checkpointDigest,
  event,
  loadRun,
  moveRun,
  moveRunAdmin,
  moveStep,
  queueStep,
  runDigest,
  stepsFor,
} from './store.js';
import { ADMIN_TRANSITIONS } from './types.js';
import { bindOwner } from './views.js';

import type { createBotExecution } from './engine.js';
import type { ExecutionOptions, RunRow, StepRow } from './types.js';
import type { Member, Tx } from '../../context.js';

export function createRunCommands(
  options: ExecutionOptions,
  execution: ReturnType<typeof createBotExecution>,
) {
  const { deps } = options;
  async function owned(member: Member, taskId: string): Promise<RunRow> {
    const initial = await loadRun(deps.sql, taskId);
    if (!initial || initial.owner_sub !== member.sub) throw new Conflict('not_found', 404);
    if (deps.config.readOnlyMembers.has(member.email)) throw new Conflict('read_only_member', 403);
    await bindOwner(options, member, initial.teammate_id);
    return initial;
  }
  /**
   * Runs an owner command in one transaction on its own connection (CR-01). The authority recheck
   * reads through the pool, so it runs first and its result is passed in; the transaction re-reads
   * the locked run, and every later step rechecks authority again before it starts.
   */
  async function command(
    member: Member,
    taskId: string,
    action: (tx: Tx, run: RunRow, denial: string | null) => Promise<void>,
  ) {
    const denial = await recheck(options, await owned(member, taskId));
    let settled: RunRow | undefined;
    await deps.sql.begin(async (tx) => {
      const run = await loadRun(tx, taskId, true);
      if (!run) throw new Conflict('not_found', 404);
      await action(tx, run, denial);
      settled = run;
    });
    if (settled) await execution.release(settled);
  }
  async function denyApproval(tx: Tx, run: RunRow, code: string) {
    for (const step of (await stepsFor(tx, run.task_id)).filter((s) =>
      BOT_STEP_OPEN.has(s.status),
    )) {
      const status =
        step.status === 'waiting_approval' && code === 'declined' ? 'failed' : 'blocked';
      await moveStep(deps, tx, step, status, code);
    }
    await moveRun(deps, tx, run, 'failed', code);
  }
  async function resumeApproval(tx: Tx, run: RunRow, stepId: string | null) {
    const checkpoint = (await stepsFor(tx, run.task_id)).find((s) => s.step_id === stepId);
    if (checkpoint) {
      await moveStep(deps, tx, checkpoint, 'running');
      await moveStep(deps, tx, checkpoint, 'succeeded');
    }
    if (run.status !== 'running') await moveRun(deps, tx, run, 'running');
    await execution.advance(tx, run);
  }
  return {
    async approve(
      member: Member,
      taskId: string,
      approvalId: string,
      input: { decision: 'approve' | 'decline'; actionDigest: string },
    ) {
      const owner = await loadRun(deps.sql, taskId);
      if (owner && owner.owner_sub !== member.sub) throw new Conflict('wrong_actor', 403);
      await command(member, taskId, async (tx, run, denial) => {
        if (['cancel_requested', 'cancelled', 'outcome_uncertain'].includes(run.status)) {
          await event(deps, tx, taskId, 'late_approval_ignored');
          return;
        }
        const approval = (await approvalsFor(tx, taskId)).find((a) => a.id === approvalId);
        if (!approval || approval.state !== 'pending' || approval.expires_at <= deps.now())
          throw new Conflict('stale_approval');
        const digest = approval.step_id
          ? checkpointDigest(run, approval.step_id, await stepsFor(tx, taskId))
          : runDigest(run);
        if (input.actionDigest !== approval.payload_sha256 || digest !== approval.payload_sha256)
          throw new Conflict('stale_approval');
        if (denial) {
          await denyApproval(tx, run, denial);
          return;
        }
        await tx`update wb_approvals set state = ${input.decision === 'approve' ? 'approved' : 'rejected'}, decided_by = ${member.sub}, decided_at = ${deps.now()} where id = ${approvalId} and state = 'pending'`;
        await tx`update tw_inbox set state = 'resolved', resolved_at = ${deps.now()} where task_id = ${taskId} and ref = ${approvalId}`;
        if (input.decision === 'decline') await denyApproval(tx, run, 'declined');
        else await resumeApproval(tx, run, approval.step_id);
        await event(deps, tx, taskId, `approval_${input.decision}`);
      });
    },
    cancel: (member: Member, taskId: string) =>
      command(member, taskId, async (tx, run) => {
        if (BOT_RUN_TERMINAL.has(run.status) || run.status === 'cancel_requested') return;
        await tx`update tw_bot_runs set cancel_requested_at=${deps.now()} where task_id=${taskId}`;
        await moveRun(deps, tx, run, 'cancel_requested');
        await tx`update wb_approvals set state = 'void' where task_id = ${taskId} and state = 'pending'`;
        for (const step of await stepsFor(tx, taskId)) {
          if (BOT_STEP_OPEN.has(step.status))
            await moveStep(deps, tx, step, 'cancelled', 'cancel_requested');
          if (step.status === 'waiting_external' || step.status === 'running') {
            await queueStep(deps, tx, taskId, step.step_id);
            await tx`update tw_jobs set run_after = ${deps.now()} where kind = 'bot_step' and ref = ${`${taskId}:${step.step_id}`} and state = 'queued'`;
          }
        }
        await execution.finishCancel(tx, run);
      }),
    async retry(member: Member, taskId: string, stepId: string) {
      const initial = await owned(member, taskId);
      const retryable = (run: RunRow, steps: readonly StepRow[]) => {
        const step = steps.find((s) => s.step_id === stepId);
        if (
          !step ||
          step.status !== 'failed' ||
          run.status !== 'failed' ||
          steps.some((s) => ['cancelled', 'outcome_uncertain'].includes(s.status))
        )
          throw new Conflict('retry_not_allowed');
        return step;
      };
      const before = retryable(initial, await stepsFor(deps.sql, taskId));
      const denial = await recheck(options, initial);
      if (denial) throw new Conflict(denial, 403);
      // Admission uses its own connections, so it runs before the transaction (CR-01); if the
      // transaction then fails, the reservation goes back to the run's terminal state (CR-07).
      await deps.sql`update admission_reservations set state='expired' where execution_id=${taskId} and state='failed'`;
      const admitted = await options.admission.admit({
        executionId: taskId,
        botId: initial.teammate_id,
        memberId: initial.owner_sub,
        segmentId: deps.config.segment,
        windowKey: initial.created_at.toISOString().slice(0, 10),
        estimatedCostMicros: 0,
      });
      if (!admitted.admitted) throw new Conflict('admission_denied');
      let settled: RunRow | undefined;
      try {
        await deps.sql.begin(async (tx) => {
          const run = await loadRun(tx, taskId, true);
          if (!run) throw new Conflict('not_found', 404);
          const step = retryable(run, await stepsFor(tx, taskId));
          if (step.attempt !== before.attempt) throw new Conflict('stale_step');
          // A retry makes the run active again, so the definition's ceilings apply (T8-02).
          if (await definitionCeiling(tx, run)) throw new Conflict('admission_denied');
          const updated =
            await tx`update tw_bot_steps set status = ${ADMIN_TRANSITIONS.step.failed[0]}, attempt = attempt + 1, owner_token = null, idempotency_key = null,
        cost_history=case when kind='mcp_delegate' and idempotency_key is not null then cost_history || jsonb_build_array(jsonb_build_object('attempt',attempt,'cost',coalesce(cost,'{"basis":"unknown"}'::jsonb))) else cost_history end,
        external = null, input = null, output = null, cost = null, error_code = null, terminal_reason = null, started_at = null, finished_at = null
        where task_id = ${taskId} and step_id = ${stepId} and status = 'failed' and attempt = ${step.attempt} returning 1`;
          if (!updated.length) throw new Conflict('stale_step');
          // Steps blocked by this failure, including those after a declined checkpoint (CR-02).
          await tx`update tw_bot_steps set status = 'pending', error_code = null, terminal_reason = null, finished_at = null
        where task_id = ${taskId} and status = 'blocked' and terminal_reason in ('dependency_failed', 'declined')`;
          await moveRunAdmin(deps, tx, run, 'running');
          await queueStep(deps, tx, taskId, stepId);
          await audit(deps, tx, {
            ownerSub: member.sub,
            taskId,
            action: 'bot.retry',
            outcome: 'ready',
            detail: { stepId, attempt: step.attempt + 1 },
          });
          settled = run;
        });
      } catch (error) {
        // Every attempt shares the run's execution id, so a concurrent retry that won owns this
        // reservation now; release it only while the run is still failed.
        if ((await loadRun(deps.sql, taskId))?.status === 'failed')
          await options.admission.release(taskId, 'failed');
        throw error;
      }
      if (settled) await execution.release(settled);
    },
    resolve: (
      member: Member,
      taskId: string,
      stepId: string,
      input: { outcome: 'succeeded' | 'failed'; note: string },
    ) =>
      command(member, taskId, async (tx, run) => {
        const step = (await stepsFor(tx, taskId)).find((s) => s.step_id === stepId);
        if (
          !step ||
          run.cancel_requested_at ||
          step.status !== 'outcome_uncertain' ||
          run.status !== 'outcome_uncertain'
        )
          throw new Conflict('resolve_not_allowed');
        const changed =
          await tx`update tw_bot_steps set status = ${input.outcome}, terminal_reason = 'resolved_by_owner', error_code = null, output = null, finished_at = ${deps.now()}
        where task_id = ${taskId} and step_id = ${stepId} and status = 'outcome_uncertain' and attempt = ${step.attempt} returning 1`;
        if (!changed.length) throw new Conflict('stale_step');
        await tx`update tw_bot_steps set terminal_reason = ${input.outcome === 'succeeded' ? 'resolved_without_output' : 'dependency_failed'} where task_id = ${taskId} and status = 'blocked'`;
        // With no uncertainty left the run ends failed with the resolution as its reason, so a
        // step resolved as failed can be retried (CR-03).
        if (!(await stepsFor(tx, taskId)).some((s) => s.status === 'outcome_uncertain'))
          await moveRunAdmin(
            deps,
            tx,
            run,
            'failed',
            input.outcome === 'succeeded' ? 'resolved_without_output' : 'resolved_by_owner',
          );
        await audit(deps, tx, {
          ownerSub: member.sub,
          taskId,
          action: 'bot.resolve',
          outcome: input.outcome,
          detail: { stepId, note: input.note },
        });
        await event(deps, tx, taskId, 'resolved_by_owner');
      }),
  };
}
