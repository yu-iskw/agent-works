import { BOT_RUN_TERMINAL } from '@agent-works/domain';

import { Conflict } from '../../context.js';

import { costView } from './cost.js';
import { approvalsFor, loadRun, stepsFor } from './store.js';

import type { ExecutionOptions, RunRow, StepRow, ApprovalRow } from './types.js';
import type { Member } from '../../context.js';

export async function bindOwner(
  options: ExecutionOptions,
  member: Member,
  teammateId: string,
): Promise<void> {
  const { deps } = options;
  const found =
    await deps.sql`update tw_bots set owner_email = ${member.email.toLowerCase()} where teammate_id = ${teammateId} and owner_sub = ${member.sub} returning 1`;
  if (!found.length) throw new Conflict('not_found', 404);
}
export async function runView(options: ExecutionOptions, member: Member, taskId: string) {
  const { deps } = options;
  const run = await loadRun(deps.sql, taskId);
  if (!run || run.owner_sub !== member.sub) throw new Conflict('not_found', 404);
  const [steps, approvals] = await Promise.all([
    stepsFor(deps.sql, taskId),
    approvalsFor(deps.sql, taskId),
  ]);
  const cost = await costView(deps.sql, taskId, steps);
  const active = !BOT_RUN_TERMINAL.has(run.status) && run.status !== 'cancel_requested';
  return {
    taskId,
    teammateId: run.teammate_id,
    revision: run.revision,
    status: run.status,
    trigger: {
      kind: run.trigger_kind,
      ref: run.trigger_kind === 'manual' ? null : run.trigger_ref,
    },
    createdAt: run.created_at.toISOString(),
    finishedAt: run.finished_at?.toISOString() ?? null,
    digest: run.digest,
    initiatedBy: run.initiated_by,
    ownerSub: run.owner_sub,
    executionSub: run.execution_sub,
    approvalMode: run.approval_mode,
    grantId: run.grant_id,
    startedAt: run.started_at?.toISOString() ?? null,
    lastError: run.error_code ? { code: run.error_code, message: run.error_code } : null,
    steps: run.definition.workflow.steps.map((def) => {
      const step = steps.find((s) => s.step_id === def.id);
      if (!step) throw new Error('missing_step');
      return {
        stepId: step.step_id,
        kind: step.kind,
        title: def.title,
        status: step.status,
        attempt: step.attempt,
        startedAt: step.started_at?.toISOString() ?? null,
        finishedAt: step.finished_at?.toISOString() ?? null,
        errorCode: step.error_code,
        terminalReason: step.terminal_reason,
        external: step.external,
        outputSummary: step.output?.text ?? null,
      };
    }),
    approvals: approvals.map((a) => ({
      id: a.id,
      subject: a.subject,
      stepId: a.step_id,
      state: a.state,
      prompt: a.proposal.prompt,
      actionDigest: a.payload_sha256,
      requestedAt: a.requested_at.toISOString(),
      expiresAt: a.expires_at.toISOString(),
      decidedBy: a.decided_by,
    })),
    cost,
    result: run.result_text === null ? null : { text: run.result_text },
    actions: actionsFor(run, steps, approvals, active, deps.now()),
  };
}
function actionsFor(
  run: RunRow,
  steps: StepRow[],
  approvals: ApprovalRow[],
  active: boolean,
  now: Date,
) {
  return {
    canCancel: active,
    canRetry:
      run.status === 'failed' &&
      !steps.some((s) => ['cancelled', 'outcome_uncertain'].includes(s.status))
        ? steps.filter((s) => s.status === 'failed').map((s) => s.step_id)
        : [],
    canResolve:
      run.status === 'outcome_uncertain' && !run.cancel_requested_at
        ? steps.filter((s) => s.status === 'outcome_uncertain').map((s) => s.step_id)
        : [],
    canApprove: active
      ? approvals.filter((a) => a.state === 'pending' && a.expires_at > now).map((a) => a.id)
      : [],
  };
}
