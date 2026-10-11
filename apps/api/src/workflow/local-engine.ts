import { outboxEventSchema, terminalStatuses } from '@agent-works/domain';

import { LedgerConflict } from '../ports/ledger-port.js';

import type { WorkflowLog } from './workflow-log.js';
import type { LedgerPort } from '../ports/ledger-port.js';
import type { WorkflowPort } from '../ports/workflow.js';
import type {
  OutboxEvent,
  TaskStatus,
  WorkflowCheckpoint,
  WorkflowSignal,
} from '@agent-works/domain';

export type WorkflowStep = {
  readonly id: string;
  run(context: { readonly signal: AbortSignal }): Promise<string>;
};

export type WorkflowPlan = {
  readonly taskId: string;
  readonly subject: string;
  readonly steps: readonly WorkflowStep[];
};

type RunReport = {
  readonly taskId: string;
  readonly status: TaskStatus;
  readonly message: string;
  readonly resumedFrom: string | undefined;
  readonly receipts: readonly { readonly stepId: string; readonly body: string }[];
};

type SignalEffect =
  | { readonly effect: 'duplicate'; readonly report: RunReport }
  | { readonly effect: 'resumed'; readonly report: RunReport }
  | { readonly effect: 'cancelled'; readonly report: RunReport };

type CancelResult =
  | { readonly ok: true; readonly status: TaskStatus; readonly duplicate: boolean }
  | { readonly ok: false; readonly reason: 'not_found' };

export type EngineDeps = {
  readonly workflow: WorkflowPort;
  readonly log: WorkflowLog;
  readonly ledger: LedgerPort;
  readonly maxAttempts?: number;
  readonly now?: () => Date;
};

export type LocalEngine = {
  run(plan: WorkflowPlan): Promise<RunReport>;
  halt(taskId: string): void;
  deliver(signal: WorkflowSignal, plan: WorkflowPlan): Promise<SignalEffect>;
  cancel(subject: string, taskId: string, signalId: string): Promise<CancelResult>;
};

const defaultAttempts = 3;
const startedMessage = 'started';
const running = 'RUNNING' as const;
const retrying = 'RETRYING' as const;
const completed = 'COMPLETED' as const;
const failed = 'FAILED' as const;
const cancelled = 'CANCELLED' as const;
const successOutcome = 'SUCCESS';
const failureOutcome = 'FAILURE';
const cancelOutcome = 'CANCELLED';
const agentPrincipal = 'agent:workflow';
const schemaVersion = '1';
const workDestination = 'work';
const missingStep = 'done';
const cancelStep = 'cancel';

type LiveRun = {
  abort: AbortController;
  reason: 'run' | 'halt' | 'cancel';
  done: Promise<RunReport>;
};

type EngineContext = {
  readonly deps: EngineDeps;
  readonly live: Map<string, LiveRun>;
  readonly attempts: number;
  readonly now: () => Date;
};

type Walk = 'completed' | 'cancelled' | 'failed' | 'halted';

type StepAttempt =
  | { readonly kind: 'body'; readonly body: string }
  | { readonly kind: 'stopped' }
  | { readonly kind: 'failed' };

type StepOutcome = typeof successOutcome | typeof failureOutcome | typeof cancelOutcome;

type StepEventInput = {
  readonly taskId: string;
  readonly subject: string;
  readonly stepId: string;
  readonly outcome: StepOutcome;
  readonly receipt: string | null;
  readonly eventId: string;
};

export function createLocalEngine(deps: EngineDeps): LocalEngine {
  const ctx: EngineContext = {
    deps,
    live: new Map(),
    attempts: deps.maxAttempts ?? defaultAttempts,
    now: deps.now ?? (() => new Date()),
  };
  return {
    run: (plan) => runPlan(ctx, plan),
    halt: (taskId) => stopLive(ctx.live, taskId, 'halt'),
    deliver: (signal, plan) => deliverSignal(ctx, signal, plan),
    cancel: (subject, taskId, signalId) => cancelTask(ctx, subject, taskId, signalId),
  };
}

async function runPlan(ctx: EngineContext, plan: WorkflowPlan): Promise<RunReport> {
  const existing = ctx.live.get(plan.taskId);
  if (existing !== undefined) return existing.done;
  let resolveDone: (report: RunReport) => void = () => {};
  let rejectDone: (error: Error) => void = () => {};
  const done = new Promise<RunReport>((resolve, reject) => {
    resolveDone = resolve;
    rejectDone = reject;
  });
  void done.catch(() => undefined);
  const current: LiveRun = { abort: new AbortController(), reason: 'run', done };
  ctx.live.set(plan.taskId, current);
  try {
    const report = await execute(ctx, current, plan);
    resolveDone(report);
    return report;
  } catch (error) {
    rejectDone(error instanceof Error ? error : new Error('workflow'));
    throw error;
  } finally {
    if (ctx.live.get(plan.taskId) === current) ctx.live.delete(plan.taskId);
  }
}

async function execute(
  ctx: EngineContext,
  current: LiveRun,
  plan: WorkflowPlan,
): Promise<RunReport> {
  const prior = await ctx.deps.workflow.read(plan.taskId);
  if (prior === undefined) {
    return finishWalk(ctx, plan, await walk(ctx, current, plan, 0), undefined);
  }
  if (terminalStatuses.includes(prior.status)) {
    return report(ctx, plan, prior.status, prior.stepId);
  }
  const start = stepIndex(plan.steps, prior.stepId);
  if (start < 0) throw new Error(`unknown step ${prior.stepId}`);
  return finishWalk(ctx, plan, await walk(ctx, current, plan, start), prior.stepId);
}

async function finishWalk(
  ctx: EngineContext,
  plan: WorkflowPlan,
  outcome: Walk,
  resumedFrom: string | undefined,
): Promise<RunReport> {
  if (outcome === 'completed') {
    const stored = await saveProgress(ctx, {
      taskId: plan.taskId,
      stepId: lastStepId(plan.steps),
      status: completed,
    });
    return report(ctx, plan, stored ?? completed, resumedFrom);
  }
  if (outcome === 'failed') return report(ctx, plan, failed, resumedFrom);
  if (outcome === 'cancelled') return report(ctx, plan, cancelled, resumedFrom);
  const cursor = await ctx.deps.workflow.read(plan.taskId);
  return report(ctx, plan, cursor === undefined ? running : cursor.status, resumedFrom);
}

async function walk(
  ctx: EngineContext,
  current: LiveRun,
  plan: WorkflowPlan,
  start: number,
): Promise<Walk> {
  for (let index = start; index < plan.steps.length; index += 1) {
    const outcome = await walkStep(ctx, current, plan, index);
    if (outcome !== 'continue') return outcome;
  }
  return 'completed';
}

async function walkStep(
  ctx: EngineContext,
  current: LiveRun,
  plan: WorkflowPlan,
  index: number,
): Promise<Walk | 'continue'> {
  const stopped = stopOutcome(current);
  if (stopped !== undefined) return stopped;
  const step = stepAt(plan.steps, index);
  if (step === undefined) return 'completed';
  const existing = await ctx.deps.log.list(plan.taskId);
  const stoppedAfterRead = stopOutcome(current);
  if (stoppedAfterRead !== undefined) return stoppedAfterRead;
  const shared = await terminalWalk(ctx, plan.taskId);
  if (shared !== undefined) return shared;
  const prior = existing.find((row) => row.stepId === step.id);
  if (prior !== undefined) {
    await appendStep(ctx, plan, step.id, successOutcome, prior.body);
    return stopOutcome(current) ?? 'continue';
  }
  const outcome = await runStep(ctx, current, plan, step);
  if (outcome !== 'completed') return outcome;
  return 'continue';
}

async function runStep(
  ctx: EngineContext,
  current: LiveRun,
  plan: WorkflowPlan,
  step: WorkflowStep,
): Promise<Walk> {
  const before = stopOutcome(current);
  if (before !== undefined) return before;
  const noted = await note(ctx, current, plan.taskId, step.id, running);
  if (noted !== undefined) return noted;
  const attempt = await perform(ctx, current, plan.taskId, step);
  if (attempt.kind === 'stopped') return afterStop(ctx, current, plan.taskId);
  if (attempt.kind === 'failed') return afterFailure(ctx, current, plan, step);
  return afterBody(ctx, current, plan, step, attempt.body);
}

async function afterStop(ctx: EngineContext, current: LiveRun, taskId: string): Promise<Walk> {
  if (liveReason(current) === 'cancel') await markCancelled(ctx, taskId);
  return stopOutcome(current) ?? 'halted';
}

async function afterFailure(
  ctx: EngineContext,
  current: LiveRun,
  plan: WorkflowPlan,
  step: WorkflowStep,
): Promise<Walk> {
  if (liveReason(current) === 'cancel') {
    await markCancelled(ctx, plan.taskId);
    return 'cancelled';
  }
  const stored = await saveProgress(ctx, {
    taskId: plan.taskId,
    stepId: step.id,
    status: failed,
  });
  if (stored !== undefined) return walkOf(stored);
  await appendStep(ctx, plan, step.id, failureOutcome, null);
  return 'failed';
}

async function afterBody(
  ctx: EngineContext,
  current: LiveRun,
  plan: WorkflowPlan,
  step: WorkflowStep,
  body: string,
): Promise<Walk> {
  await ctx.deps.log.put(plan.taskId, step.id, body);
  await appendStep(ctx, plan, step.id, successOutcome, body);
  if (liveReason(current) === 'cancel') {
    await markCancelled(ctx, plan.taskId);
    return 'cancelled';
  }
  const shared = await terminalWalk(ctx, plan.taskId);
  if (shared !== undefined) return shared;
  return stopOutcome(current) ?? 'completed';
}

type AttemptInput = {
  readonly ctx: EngineContext;
  readonly current: LiveRun;
  readonly taskId: string;
  readonly step: WorkflowStep;
  readonly attempt: number;
};

async function perform(
  ctx: EngineContext,
  current: LiveRun,
  taskId: string,
  step: WorkflowStep,
): Promise<StepAttempt> {
  for (;;) {
    const attempt = await ctx.deps.log.bump(taskId, step.id);
    const outcome = await tryOnce({ ctx, current, taskId, step, attempt });
    if (outcome !== 'retry') return outcome;
  }
}

async function tryOnce(input: AttemptInput): Promise<StepAttempt | 'retry'> {
  const signal = input.current.abort.signal;
  if (wasAborted(signal)) return { kind: 'stopped' };
  try {
    const body = await input.step.run({ signal });
    return { kind: 'body', body };
  } catch {
    return failedAttempt(input, signal);
  }
}

async function failedAttempt(
  input: AttemptInput,
  signal: AbortSignal,
): Promise<StepAttempt | 'retry'> {
  if (wasAborted(signal)) return { kind: 'stopped' };
  if (input.attempt >= input.ctx.attempts) return { kind: 'failed' };
  const noted = await note(input.ctx, input.current, input.taskId, input.step.id, retrying);
  if (noted !== undefined) return { kind: 'stopped' };
  return 'retry';
}

async function deliverSignal(
  ctx: EngineContext,
  signal: WorkflowSignal,
  plan: WorkflowPlan,
): Promise<SignalEffect> {
  const outcome = await ctx.deps.workflow.signal(signal);
  if (outcome === 'duplicate') {
    if (signal.kind === 'cancel') {
      const healed = await healCancel(ctx, plan.subject, plan.taskId);
      if (healed !== undefined) {
        return { effect: 'cancelled', report: await report(ctx, plan, healed, undefined) };
      }
    }
    return { effect: 'duplicate', report: await currentReport(ctx, plan) };
  }
  switch (signal.kind) {
    case 'cancel': {
      const status = await applyCancel(ctx, plan.subject, plan.taskId);
      return { effect: 'cancelled', report: await report(ctx, plan, status, undefined) };
    }
    case 'resume':
      return { effect: 'resumed', report: await runPlan(ctx, plan) };
    default: {
      const neverKind: never = signal.kind;
      throw new Error(neverKind);
    }
  }
}

async function cancelTask(
  ctx: EngineContext,
  subject: string,
  taskId: string,
  signalId: string,
): Promise<CancelResult> {
  const task = await ctx.deps.ledger.read(subject, taskId);
  if (task === undefined) return { ok: false, reason: 'not_found' };
  const outcome = await ctx.deps.workflow.signal({ taskId, signalId, kind: 'cancel' });
  if (outcome === 'duplicate') {
    const healed = await healCancel(ctx, subject, taskId);
    if (healed !== undefined) return { ok: true, status: healed, duplicate: true };
    const prior = await ctx.deps.workflow.read(taskId);
    return { ok: true, status: prior === undefined ? cancelled : prior.status, duplicate: true };
  }
  const status = await applyCancel(ctx, subject, taskId);
  return { ok: true, status, duplicate: false };
}

async function healCancel(
  ctx: EngineContext,
  subject: string,
  taskId: string,
): Promise<TaskStatus | undefined> {
  const prior = await ctx.deps.workflow.read(taskId);
  if (prior !== undefined && terminalStatuses.includes(prior.status)) return undefined;
  return applyCancel(ctx, subject, taskId);
}

async function applyCancel(
  ctx: EngineContext,
  subject: string,
  taskId: string,
): Promise<TaskStatus> {
  stopLive(ctx.live, taskId, 'cancel');
  const prior = await ctx.deps.workflow.read(taskId);
  const status = await markCancelled(ctx, taskId);
  const newlyCancelled =
    status === cancelled && (prior === undefined || !terminalStatuses.includes(prior.status));
  if (newlyCancelled) await appendCancel(ctx, subject, taskId);
  return status;
}

async function note(
  ctx: EngineContext,
  current: LiveRun,
  taskId: string,
  stepId: string,
  status: TaskStatus,
): Promise<Walk | undefined> {
  const blocked = await stoppedWalk(ctx, current, taskId);
  if (blocked !== undefined) return blocked;
  const stored = await saveProgress(ctx, { taskId, stepId, status });
  if (stored !== undefined) return walkOf(stored);
  return stoppedWalk(ctx, current, taskId);
}

async function saveProgress(
  ctx: EngineContext,
  checkpoint: WorkflowCheckpoint,
): Promise<TaskStatus | undefined> {
  const prior = await ctx.deps.workflow.read(checkpoint.taskId);
  if (prior !== undefined && terminalStatuses.includes(prior.status)) return prior.status;
  const stored = await ctx.deps.workflow.save(checkpoint);
  if (stored.status !== checkpoint.status && terminalStatuses.includes(stored.status)) {
    return stored.status;
  }
  return undefined;
}

async function terminalWalk(ctx: EngineContext, taskId: string): Promise<Walk | undefined> {
  const prior = await ctx.deps.workflow.read(taskId);
  if (prior === undefined || !terminalStatuses.includes(prior.status)) return undefined;
  return walkOf(prior.status);
}

function walkOf(status: TaskStatus): Walk {
  if (status === failed) return 'failed';
  if (status === cancelled) return 'cancelled';
  return 'completed';
}

async function stoppedWalk(
  ctx: EngineContext,
  current: LiveRun,
  taskId: string,
): Promise<Walk | undefined> {
  const reason = liveReason(current);
  if (reason === 'cancel') {
    await markCancelled(ctx, taskId);
    return 'cancelled';
  }
  if (reason === 'halt') return 'halted';
  return undefined;
}

function liveReason(current: LiveRun): LiveRun['reason'] {
  return current.reason;
}

function wasAborted(signal: AbortSignal): boolean {
  return signal.aborted;
}

async function markCancelled(ctx: EngineContext, taskId: string): Promise<TaskStatus> {
  const prior = await ctx.deps.workflow.read(taskId);
  if (prior !== undefined && terminalStatuses.includes(prior.status)) return prior.status;
  await ctx.deps.workflow.save({
    taskId,
    stepId: prior === undefined ? cancelStep : prior.stepId,
    status: cancelled,
  });
  return cancelled;
}

function stopLive(live: Map<string, LiveRun>, taskId: string, reason: 'halt' | 'cancel'): void {
  const current = live.get(taskId);
  if (current === undefined) return;
  current.reason = reason;
  current.abort.abort();
}

function stopOutcome(current: LiveRun): Walk | undefined {
  if (current.reason === 'cancel') return 'cancelled';
  if (current.reason === 'halt') return 'halted';
  return undefined;
}

async function currentReport(ctx: EngineContext, plan: WorkflowPlan): Promise<RunReport> {
  const prior = await ctx.deps.workflow.read(plan.taskId);
  if (prior === undefined) return report(ctx, plan, running, undefined);
  return report(ctx, plan, prior.status, prior.stepId);
}

async function report(
  ctx: EngineContext,
  plan: WorkflowPlan,
  status: TaskStatus,
  resumedFrom: string | undefined,
): Promise<RunReport> {
  return {
    taskId: plan.taskId,
    status,
    message: resumedFrom === undefined ? startedMessage : `resumed from ${resumedFrom}`,
    resumedFrom,
    receipts: await ctx.deps.log.list(plan.taskId),
  };
}

async function appendStep(
  ctx: EngineContext,
  plan: WorkflowPlan,
  stepId: string,
  outcome: typeof successOutcome | typeof failureOutcome,
  receipt: string | null,
): Promise<void> {
  await appendLedger(ctx, {
    taskId: plan.taskId,
    subject: plan.subject,
    stepId,
    outcome,
    receipt,
    eventId: `workflow:${plan.taskId}:${stepId}:${outcome}`,
  });
}

async function appendCancel(ctx: EngineContext, subject: string, taskId: string): Promise<void> {
  const prior = await ctx.deps.workflow.read(taskId);
  const stepId = prior === undefined ? cancelStep : prior.stepId;
  await appendLedger(ctx, {
    taskId,
    subject,
    stepId,
    outcome: cancelOutcome,
    receipt: null,
    eventId: `workflow:${taskId}:cancel`,
  });
}

async function appendLedger(ctx: EngineContext, input: StepEventInput): Promise<void> {
  try {
    await ctx.deps.ledger.append(stepEvent(ctx, input));
  } catch (error) {
    if (error instanceof LedgerConflict) return;
    throw error;
  }
}

function stepEvent(ctx: EngineContext, input: StepEventInput): OutboxEvent {
  return outboxEventSchema.parse({
    destination: workDestination,
    event: {
      eventId: input.eventId,
      eventType: input.outcome === cancelOutcome ? 'workflow.cancelled' : 'workflow.step',
      schemaVersion,
      occurredAt: ctx.now().toISOString(),
      taskId: input.taskId,
      stepId: input.stepId,
      traceId: traceOf(input.taskId),
      initiatorSubject: input.subject,
      agentPrincipal,
      tool: null,
      policyDecisionId: null,
      approvalId: null,
      requestDigestSha256: null,
      outcome: input.outcome,
      externalObjectRef: input.receipt !== null && input.receipt.length > 0 ? input.receipt : null,
      prevDigest: null,
    },
  });
}

function traceOf(taskId: string): string {
  const stripped = taskId.replaceAll('-', '');
  return stripped.length > 0 ? stripped : taskId;
}

function stepIndex(steps: readonly WorkflowStep[], stepId: string): number {
  return steps.findIndex((step) => step.id === stepId);
}

function stepAt(steps: readonly WorkflowStep[], index: number): WorkflowStep | undefined {
  return steps.at(index);
}

function lastStepId(steps: readonly WorkflowStep[]): string {
  return steps.at(-1)?.id ?? missingStep;
}
