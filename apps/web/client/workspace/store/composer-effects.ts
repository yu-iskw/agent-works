// Side effects behind the composer: executing a send plan, loading the menu context and follow-up
// targets, and starting a task from the draft card. The routing decisions live in
// composer-routing.ts; file uploads in composer-files.ts. This module only carries them out.

import { effect } from '@preact/signals';

import { chipKey } from '../../../shared/composer.js';
import { api as paths } from '../../../shared/contract.js';

import { KEPT_DRAFT, KEPT_MESSAGE, errorText } from './composer-errors.js';
import { createFileEffects } from './composer-files.js';
import {
  draftFromChips,
  draftProblems,
  liveTaskKeys,
  planSend,
  specialistFor,
  targetCandidates,
  taskCreateBody,
} from './composer-routing.js';
import { activeDraft } from './selectors.js';

import type { FileEffects } from './composer-files.js';
import type { SendPlan } from './composer-routing.js';
import type { EffectsDeps } from './effects.js';
import type { WorkspaceState } from './state.js';
import type {
  ComposerContext,
  ContextChip,
  FollowUpTarget,
  FollowUpTargets,
  TaskDraft,
} from '../../../shared/composer.js';

export type ComposerEffects = Pick<FileEffects, 'attachFiles' | 'retryFile'> & {
  /** One Send: chat, follow-up, or opening the task draft card, per `planSend`. */
  readonly submit: () => Promise<void>;
  readonly addChip: (chip: ContextChip) => void;
  readonly removeChip: (key: string) => void;
  readonly setTarget: (target: FollowUpTarget | null) => void;
  readonly ensureContext: () => Promise<void>;
  readonly openTaskDraft: (mode: TaskDraft['mode'], objective?: string) => void;
  readonly editTaskDraft: (patch: Partial<TaskDraft>) => void;
  readonly addSpecialist: (teammateId: string) => void;
  readonly removeSpecialist: (teammateId: string) => void;
  readonly closeTaskDraft: () => void;
  readonly startTask: () => Promise<void>;
  readonly clearError: () => void;
};

type ComposerDeps = {
  readonly deps: EffectsDeps;
  readonly pollNow: () => Promise<void>;
  readonly readText: (file: File) => Promise<string>;
};

type TaskReply = { readonly segment: string; readonly task: { readonly id: string } };

const liveTaskIds = (state: WorkspaceState): readonly string[] =>
  liveTaskKeys(state.conversation?.tasks ?? []);

const targetsKeyOf = (state: WorkspaceState): string =>
  state.conversation === null ? '' : `${state.conversation.id}:${liveTaskIds(state).join(',')}`;

const CLARIFY_TEXT = 'Choose where this goes first: pick a target above the message.';

/** What a Send that goes nowhere should say; reasons absent here are already shown by a chip. */
const NOTHING_TEXT: Partial<Record<Extract<SendPlan, { kind: 'nothing' }>['reason'], string>> = {
  files_need_chat:
    'Files go with a message to the teammate or a new task, not a follow-up. Change the target or remove the files.',
  failed_upload: 'A file failed to upload. Retry or remove it first.',
};

function refusalText(plan: SendPlan): string | null {
  if (plan.kind === 'clarify') return CLARIFY_TEXT;
  return plan.kind === 'nothing' ? (NOTHING_TEXT[plan.reason] ?? null) : null;
}

export function createComposerEffects(input: ComposerDeps): ComposerEffects & {
  readonly start: () => () => void;
} {
  const { deps, pollNow } = input;
  const { store, api, drafts } = deps;
  const { dispatch, peek } = store;
  const segment = peek().scope.segment;
  let contextLoad: Promise<void> | null = null;

  const conversationId = (): string | null => peek().conversation?.id ?? null;
  const fail = (reason: string): void => dispatch({ type: 'composer/error', reason });
  const editDraft = (patch: Partial<TaskDraft>): void =>
    dispatch({ type: 'task-draft/edit', patch });

  function addChip(chip: ContextChip): void {
    const id = conversationId();
    if (id !== null)
      dispatch({ type: 'draft/chip-add', conversationId: id, chip, mint: deps.mintId() });
  }

  const files = createFileEffects({ deps, readText: input.readText, addChip, fail });

  async function ensureContext(): Promise<void> {
    if (peek().composer.context !== null) return;
    contextLoad ??= api
      .get<ComposerContext>(paths.composer(segment))
      .then((context) => dispatch({ type: 'composer/context', context }))
      .catch(() => undefined)
      .finally(() => {
        contextLoad = null;
      });
    return contextLoad;
  }

  async function loadTargets(): Promise<void> {
    const state = peek();
    const c = state.conversation;
    const key = targetsKeyOf(state);
    if (c === null || key === state.composer.targetsKey) return;
    const ids = liveTaskIds(state).map((entry) => entry.split('@')[0]);
    const { epoch } = state;
    try {
      const tasks =
        ids.length === 0
          ? []
          : (await api.get<FollowUpTargets>(paths.targets(segment, c.id, ids))).tasks;
      dispatch({ type: 'composer/targets', epoch, conversationId: c.id, targets: tasks, key });
    } catch {
      // The previous targets stay; the next task version change retries.
    }
  }

  function removeChip(key: string): void {
    const id = conversationId();
    if (id === null) return;
    const chip = activeDraft(peek()).chips.find((c) => chipKey(c) === key);
    if (chip?.kind === 'file') files.forget(chip);
    dispatch({ type: 'draft/chip-remove', conversationId: id, key });
  }

  // ---- task draft ----

  function openTaskDraft(mode: TaskDraft['mode'], objective?: string): void {
    const state = peek();
    const c = state.conversation;
    const context = state.composer.context;
    if (c === null) return;
    if (context === null) {
      void ensureContext().then(() => openTaskDraft(mode, objective));
      return;
    }
    const draft = activeDraft(state);
    dispatch({
      type: 'task-draft/open',
      draft: draftFromChips({
        conversationId: c.id,
        clientRequestId: draft.clientRequestId ?? deps.mintId(),
        objective: objective ?? draft.text.trim(),
        mode,
        chips: draft.chips,
        current: context.teammates.find((t) => t.id === c.teammateId) ?? null,
        context,
      }),
    });
  }

  function addSpecialist(teammateId: string): void {
    const { taskDraft: draft, context } = peek().composer;
    const teammate = context?.teammates.find((t) => t.id === teammateId);
    if (draft === null || context === null || teammate === undefined) return;
    if (draft.specialists.some((s) => s.teammateId === teammateId)) return;
    const specialist = specialistFor({
      teammate,
      workflow: draft.workflow,
      context,
      wanted: new Set(),
      hasFiles: draft.attachments.length > 0,
    });
    editDraft({ specialists: [...draft.specialists, specialist] });
  }

  async function startTask(): Promise<void> {
    const state = peek();
    const draft = state.composer.taskDraft;
    if (draft === null || state.composer.starting) return;
    const problems = draftProblems(draft);
    if (problems.length > 0) {
      fail(problems.join(' '));
      return;
    }
    dispatch({ type: 'task-draft/starting', starting: true });
    try {
      await api.post<TaskReply>(paths.createTask(segment), taskCreateBody(draft));
      dispatch({ type: 'task-draft/started', conversationId: draft.conversationId });
      drafts.writeDraft(draft.conversationId, null);
      files.clear();
      await pollNow();
    } catch (error) {
      dispatch({ type: 'task-draft/starting', starting: false });
      fail(errorText(error, KEPT_DRAFT));
    }
  }

  // ---- send ----

  async function post(
    plan: Extract<SendPlan, { kind: 'chat' | 'follow_up' }>,
    clientRequestId: string,
    conversation: string,
  ) {
    if (plan.kind === 'chat')
      return api.post(paths.messages(segment, conversation), {
        clientRequestId,
        text: plan.text,
        ...(plan.attachmentIds.length > 0 ? { attachmentIds: plan.attachmentIds } : {}),
      });
    return api.post(paths.taskCommand(segment, plan.taskId, 'follow-up'), {
      clientRequestId,
      kind: plan.followUp,
      text: plan.text,
      assignmentId: plan.assignmentId,
      metrics: null,
    });
  }

  async function submit(): Promise<void> {
    const state = peek();
    const c = state.conversation;
    if (c === null || state.me.readOnly) return;
    const draft = activeDraft(state);
    const plan = planSend({
      text: draft.text,
      chips: draft.chips,
      target: draft.target,
      candidates: targetCandidates(state.composer.targets),
      sending: state.composer.sending !== null,
    });
    if (plan.kind === 'task_draft') {
      openTaskDraft(plan.mode, plan.objective);
      return;
    }
    if (plan.kind === 'nothing' || plan.kind === 'clarify') {
      const text = refusalText(plan);
      if (text !== null) fail(text);
      return;
    }
    const clientRequestId = draft.clientRequestId ?? deps.mintId();
    dispatch({ type: 'composer/sending', clientRequestId });
    if (peek().composer.sending !== clientRequestId) return;
    try {
      await post(plan, clientRequestId, c.id);
      dispatch({ type: 'composer/sent', conversationId: c.id });
      drafts.writeDraft(c.id, null);
      files.clear();
      await pollNow();
    } catch (error) {
      dispatch({ type: 'composer/failed', reason: errorText(error, KEPT_MESSAGE) });
    }
  }

  return {
    start: () =>
      effect(() => {
        // Read the conversation signal so the effect re-runs when tasks move or the room changes.
        void store.conversation.value;
        void loadTargets();
      }),
    submit,
    addChip,
    removeChip,
    setTarget: (target) => {
      const id = conversationId();
      if (id !== null) dispatch({ type: 'draft/target', conversationId: id, target });
    },
    attachFiles: files.attachFiles,
    retryFile: files.retryFile,
    ensureContext,
    openTaskDraft,
    editTaskDraft: editDraft,
    addSpecialist,
    removeSpecialist: (teammateId) => {
      const draft = peek().composer.taskDraft;
      if (draft !== null)
        editDraft({ specialists: draft.specialists.filter((s) => s.teammateId !== teammateId) });
    },
    closeTaskDraft: () => dispatch({ type: 'task-draft/close' }),
    startTask,
    clearError: () => dispatch({ type: 'composer/clear-error' }),
  };
}

export { CLARIFY_TEXT };
