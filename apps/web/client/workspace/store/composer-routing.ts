// Pure. Decides what one Send does, which follow-up targets a conversation offers, and how chips
// and text become a task draft. Tested with table cases; the effects module only executes a plan.

import { WORKFLOW_SOURCES, isWorkChip } from '../../../shared/composer.js';

import type {
  ComposerContext,
  ContextChip,
  FileChip,
  FollowUpTarget,
  MenuSource,
  MenuTeammate,
  Specialist,
  TargetTask,
  TaskDraft,
} from '../../../shared/composer.js';
import type { MetricsScope, SourceKind, Workflow } from '@agent-works/domain/teamwork';

export type SendPlan =
  | { readonly kind: 'chat'; readonly text: string; readonly attachmentIds: readonly string[] }
  | {
      readonly kind: 'follow_up';
      readonly taskId: string;
      readonly followUp: 'answer' | 'revise' | 'question';
      readonly assignmentId: string | null;
      readonly text: string;
    }
  | { readonly kind: 'task_draft'; readonly mode: TaskDraft['mode']; readonly objective: string }
  | { readonly kind: 'clarify'; readonly candidates: readonly FollowUpTarget[] }
  | {
      readonly kind: 'nothing';
      readonly reason: 'empty' | 'uploading' | 'failed_upload' | 'sending' | 'files_need_chat';
    };

export type SendInput = {
  readonly text: string;
  readonly chips: readonly ContextChip[];
  /** The member's explicit choice; null means "use the default". */
  readonly target: FollowUpTarget | null;
  readonly candidates: readonly FollowUpTarget[];
  readonly sending: boolean;
};

const COMMAND_PREFIX = /^\/(task|plan)(?:\s+|$)/;

/** `/task text` and `/plan text`, typed rather than picked. */
export function commandPrefix(
  text: string,
): { readonly mode: TaskDraft['mode']; readonly objective: string } | null {
  const m = COMMAND_PREFIX.exec(text);
  if (m === null) return null;
  return {
    mode: m[1] === 'plan' ? 'coordinated' : 'manual',
    objective: text.slice(m[0].length).trim(),
  };
}

const readyFiles = (chips: readonly ContextChip[]): readonly FileChip[] =>
  chips.flatMap((chip) => (chip.kind === 'file' && chip.status === 'ready' ? [chip] : []));

/**
 * Rules, in order:
 * 1. Sending, an upload in flight or a failed upload → nothing (the chip shows why).
 * 2. A typed `/task` or `/plan`, or any teammate, skill or source chip → task draft: chat cannot
 *    read sources, so the draft card is where the member reviews scope before work starts.
 * 3. Empty text → nothing.
 * 4. An explicit target decides. A follow-up cannot carry files, so files with one → nothing.
 * 5. No explicit target: the default (one open question → answer it; none → chat); when several
 *    targets compete the plan is to ask, never to guess.
 */
export function planSend(input: SendInput): SendPlan {
  if (input.sending) return { kind: 'nothing', reason: 'sending' };
  const files = input.chips.filter((chip): chip is FileChip => chip.kind === 'file');
  if (files.some((file) => file.status === 'uploading'))
    return { kind: 'nothing', reason: 'uploading' };
  if (files.some((file) => file.status === 'failed'))
    return { kind: 'nothing', reason: 'failed_upload' };
  const text = input.text.trim();
  const command = commandPrefix(text);
  if (command !== null) return { kind: 'task_draft', ...command };
  if (input.chips.some(isWorkChip)) return { kind: 'task_draft', mode: 'manual', objective: text };
  if (text === '') return { kind: 'nothing', reason: 'empty' };
  const attachmentIds = files.flatMap((file) =>
    file.attachmentId === null ? [] : [file.attachmentId],
  );
  const target = input.target ?? defaultTarget(input.candidates);
  if (target === null) return { kind: 'clarify', candidates: input.candidates };
  if (target.kind === 'teammate') return { kind: 'chat', text, attachmentIds };
  if (attachmentIds.length > 0) return { kind: 'nothing', reason: 'files_need_chat' };
  return {
    kind: 'follow_up',
    taskId: target.taskId,
    followUp: target.kind,
    assignmentId: target.kind === 'answer' ? target.assignmentId : null,
    text,
  };
}

/** Statuses from which no follow-up can ever apply; everything else may hold a question or result. */
const DEAD = new Set(['declined', 'cancelled']);
const MAX_TARGET_TASKS = 5;

/**
 * `<taskId>@<version>` for the newest live tasks a Send may target. The conversation lists its
 * tasks newest first, so the first entries are the ones the member is most likely replying to.
 */
export function liveTaskKeys(
  tasks: readonly { readonly id: string; readonly version: number; readonly status: string }[],
): readonly string[] {
  return tasks
    .filter((t) => !DEAD.has(t.status))
    .slice(0, MAX_TARGET_TASKS)
    .map((t) => `${t.id}@${t.version}`);
}

const REVISABLE = new Set(['ready', 'completed']);

/** Every place a Send could go, in display order: chat first, then answers, revisions, questions. */
export function targetCandidates(targets: readonly TargetTask[]): readonly FollowUpTarget[] {
  const answers: FollowUpTarget[] = targets.flatMap((task) =>
    task.openQuestions.map((q) => ({
      kind: 'answer' as const,
      taskId: task.taskId,
      assignmentId: q.assignmentId,
      teammateName: q.teammateName,
    })),
  );
  const results = targets.filter((task) => task.latestRevision > 0 && REVISABLE.has(task.status));
  const revises: FollowUpTarget[] = results.map((task) => ({
    kind: 'revise' as const,
    taskId: task.taskId,
    revision: task.latestRevision,
    title: task.title,
  }));
  const asks: FollowUpTarget[] = results.map((task) => ({
    kind: 'question' as const,
    taskId: task.taskId,
    title: task.title,
  }));
  return [{ kind: 'teammate' }, ...answers, ...revises, ...asks];
}

/**
 * The target the composer shows when the member picked none. Exactly one open question and no
 * result to revise → that question. No open question → chat. Anything else is ambiguous (null).
 */
export function defaultTarget(candidates: readonly FollowUpTarget[]): FollowUpTarget | null {
  const answers = candidates.filter((c) => c.kind === 'answer');
  const revises = candidates.filter((c) => c.kind === 'revise');
  if (answers.length === 0) return { kind: 'teammate' };
  if (answers.length === 1 && revises.length === 0) return answers[0];
  return null;
}

export function targetLabel(target: FollowUpTarget, teammateName: string): string {
  switch (target.kind) {
    case 'teammate':
      return `Reply to ${teammateName}`;
    case 'answer':
      return `Answer ${target.teammateName}'s question`;
    case 'revise':
      return `Revise ${target.title} rev ${target.revision}`;
    case 'question':
      return `Ask about ${target.title}`;
  }
}

// ---- task draft ----

const WORKFLOW_HINTS: readonly { readonly pattern: RegExp; readonly workflow: Workflow }[] = [
  { pattern: /metric|analy|data/i, workflow: 'metrics_explanation' },
  { pattern: /engineer|code|developer/i, workflow: 'engineering_proposal' },
];

/** From the teammate's attached skills first, then its template name, else research. */
function inferWorkflow(teammate: MenuTeammate | null, context: ComposerContext | null): Workflow {
  if (teammate === null) return 'research_brief';
  const skill = context?.skills.find((s) => teammate.skills.some((mine) => mine.id === s.id));
  if (skill !== undefined && skill.workflows.length > 0) return skill.workflows[0];
  const hint = WORKFLOW_HINTS.find((h) =>
    h.pattern.test(`${teammate.templateName} ${teammate.role}`),
  );
  return hint?.workflow ?? 'research_brief';
}

export type SourceOption = {
  readonly kind: SourceKind;
  readonly name: string;
  /** Null when this specialist can use it; otherwise the reason the box is disabled. */
  readonly disabled: string | null;
};

/** The sources a specialist may tick for a workflow, with the reason when one is off-limits. */
export function sourceOptions(
  workflow: Workflow,
  teammate: MenuTeammate | undefined,
  sources: readonly MenuSource[],
  hasFiles: boolean,
): readonly SourceOption[] {
  // `workflow` is the closed Workflow enum.
  // eslint-disable-next-line security/detect-object-injection
  return WORKFLOW_SOURCES[workflow].flatMap((kind) => {
    const source = sources.find((s) => s.kind === kind);
    if (source === undefined) return [];
    if (kind === 'member_file' && !hasFiles) return [];
    if (source.unavailable !== null)
      return [{ kind, name: source.name, disabled: source.unavailable }];
    const state = teammate?.capabilities.find((c) => c.capability === source.capability);
    const disabled =
      teammate === undefined
        ? null
        : state === undefined
          ? `${teammate.name} does not request this capability`
          : state.effective
            ? null
            : (state.reason ?? `Not available to ${teammate.name}`);
    return [{ kind, name: source.name, disabled }];
  });
}

const tickedSources = (
  options: readonly SourceOption[],
  wanted: ReadonlySet<SourceKind>,
): readonly SourceKind[] =>
  options
    .filter(
      (o) =>
        o.disabled === null &&
        (wanted.size === 0 || wanted.has(o.kind) || o.kind === 'member_file'),
    )
    .map((o) => o.kind);

export type SpecialistInput = {
  readonly teammate: MenuTeammate;
  readonly workflow: Workflow;
  readonly context: ComposerContext;
  /** Sources the member asked for by chip; empty means every usable one. */
  readonly wanted: ReadonlySet<SourceKind>;
  readonly hasFiles: boolean;
};

export function specialistFor(input: SpecialistInput): Specialist {
  const { teammate, workflow, context, wanted, hasFiles } = input;
  const options = sourceOptions(workflow, teammate, context.sources, hasFiles);
  return {
    teammateId: teammate.id,
    name: teammate.name,
    role: teammate.role,
    brief: '',
    sources: tickedSources(options, wanted),
  };
}

export type DraftInput = {
  readonly conversationId: string;
  readonly clientRequestId: string;
  readonly objective: string;
  readonly mode: TaskDraft['mode'];
  readonly chips: readonly ContextChip[];
  readonly current: MenuTeammate | null;
  readonly context: ComposerContext;
};

/**
 * Chips and text become a draft the member reviews. Specialists start with the @-mentioned
 * teammates, or the current one; sources are pre-ticked from what each can actually use.
 */
function workflowFor(input: DraftInput): Workflow {
  const skill = input.chips.find((chip) => chip.kind === 'skill');
  const fromSkill =
    skill === undefined
      ? undefined
      : input.context.skills.find((s) => s.id === skill.id)?.workflows[0];
  return fromSkill ?? inferWorkflow(input.current, input.context);
}

/** The @-mentioned teammates, else the current one. */
function pickedTeammates(input: DraftInput): readonly MenuTeammate[] {
  const mentioned = input.chips.flatMap((chip) =>
    chip.kind === 'teammate' ? input.context.teammates.filter((row) => row.id === chip.id) : [],
  );
  if (mentioned.length > 0) return mentioned;
  return input.current === null ? [] : [input.current];
}

/**
 * Teammates the segment lets own a result for `workflow`: those holding a synthesis skill for it.
 * The segment refuses any other owner with `no_synthesis_skill`, so the draft never offers one.
 */
export function synthesisOwners(
  context: ComposerContext,
  workflow: Workflow,
): readonly MenuTeammate[] {
  const holders = new Set(
    context.skills
      .filter((skill) => skill.synthesizes && skill.workflows.includes(workflow))
      .flatMap((skill) => skill.attachedTo),
  );
  return context.teammates.filter((teammate) => holders.has(teammate.id));
}

/** `preferred` when it may own the result, else the first valid owner, else '' (no owner exists). */
export function defaultOwner(
  context: ComposerContext,
  workflow: Workflow,
  preferred: string | null,
): string {
  const owners = synthesisOwners(context, workflow);
  return owners.find((owner) => owner.id === preferred)?.id ?? owners.at(0)?.id ?? '';
}

export function draftFromChips(input: DraftInput): TaskDraft {
  const { chips, context, current } = input;
  const workflow = workflowFor(input);
  const wanted = new Set(chips.flatMap((chip) => (chip.kind === 'source' ? [chip.source] : [])));
  const files = readyFiles(chips);
  const picked = pickedTeammates(input);
  const engineering = workflow === 'engineering_proposal';
  const specialists = picked.map((teammate) =>
    specialistFor({ teammate, workflow, context, wanted, hasFiles: files.length > 0 }),
  );
  return {
    clientRequestId: input.clientRequestId,
    conversationId: input.conversationId,
    objective: input.objective,
    workflow,
    mode: input.mode,
    resultOwnerId: defaultOwner(context, workflow, current?.id ?? picked.at(0)?.id ?? null),
    specialists,
    attachments: files.map((file) => ({ id: file.attachmentId ?? '', name: file.name })),
    repository: engineering ? (context.repositories.at(0) ?? null) : null,
    issueNumber: engineering ? context.issue : null,
    metrics: null,
    expanded: false,
  };
}

const MONTH = /^\d{4}-\d{2}$/;

/** The metrics scope a draft can hold: both months complete, else null while the member types. */
export function completeMetrics(fields: MetricsScope): MetricsScope | null {
  return MONTH.test(fields.baseline) && MONTH.test(fields.current) ? fields : null;
}

/** What `POST /tasks` needs, or the reason the draft cannot start yet. */
/** One rule per line: the problem text when the rule fails, else null. */
const DRAFT_RULES: readonly ((draft: TaskDraft) => string | null)[] = [
  (d) => (d.objective.trim() === '' ? 'Write what the task should find out.' : null),
  (d) =>
    d.resultOwnerId === ''
      ? 'No teammate can own the result: attach a synthesis skill for this workflow to a teammate under Details.'
      : null,
  (d) =>
    d.mode === 'manual' && d.specialists.length === 0 ? 'Add at least one specialist.' : null,
  (d) =>
    d.mode === 'manual'
      ? d.specialists
          .filter((s) => s.sources.length === 0)
          .map((s) => `Tick at least one source for ${s.name}.`)
          .join(' ') || null
      : null,
  (d) =>
    d.workflow === 'engineering_proposal' && d.repository === null ? 'Choose a repository.' : null,
  (d) =>
    d.workflow === 'engineering_proposal' && d.issueNumber === null
      ? 'Enter the issue number.'
      : null,
  (d) =>
    d.workflow === 'metrics_explanation' && d.metrics === null
      ? 'Choose the baseline and current months.'
      : null,
  (d) =>
    d.workflow === 'metrics_explanation' &&
    d.metrics !== null &&
    d.metrics.baseline === d.metrics.current
      ? 'The baseline and current months must differ.'
      : null,
];

/** What `POST /tasks` still needs, in the order the card shows the fields. */
export function draftProblems(draft: TaskDraft): readonly string[] {
  return DRAFT_RULES.flatMap((rule) => {
    const problem = rule(draft);
    return problem === null ? [] : [problem];
  });
}

/** The exact body for `POST /tasks`; the BFF parses it with the domain schema. */
export function taskCreateBody(draft: TaskDraft): unknown {
  return {
    clientRequestId: draft.clientRequestId,
    workflow: draft.workflow,
    mode: draft.mode,
    scope: {
      question: draft.objective.trim(),
      metrics: draft.metrics,
      repository: draft.repository,
      issueNumber: draft.issueNumber,
      attachmentIds: draft.attachments.map((file) => file.id),
    },
    resultOwner: draft.resultOwnerId,
    conversationId: draft.conversationId,
    assignments:
      draft.mode === 'manual'
        ? draft.specialists.map((s) => ({
            teammateId: s.teammateId,
            brief: s.brief.trim() === '' ? draft.objective.trim() : s.brief.trim(),
            sources: s.sources,
          }))
        : [],
  };
}
