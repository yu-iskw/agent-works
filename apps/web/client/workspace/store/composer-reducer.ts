// Composer handlers, spread into the main reducer table. Each is a small pure function over the
// draft of one conversation or the composer slice; a file chip moves uploading → ready | failed.

import { chipKey } from '../../../shared/composer.js';

import { draftOf } from './selectors.js';

import type { Handlers } from './reducer.js';
import type { Draft, WorkspaceState } from './state.js';
import type {
  ComposerContext,
  ContextChip,
  FileChip,
  FollowUpTarget,
  TargetTask,
  TaskDraft,
} from '../../../shared/composer.js';

export type ComposerAction =
  | {
      readonly type: 'draft/chip-add';
      readonly conversationId: string;
      readonly chip: ContextChip;
      readonly mint: string;
    }
  | { readonly type: 'draft/chip-remove'; readonly conversationId: string; readonly key: string }
  | {
      readonly type: 'draft/file';
      readonly conversationId: string;
      readonly localId: string;
      readonly patch: Partial<Omit<FileChip, 'kind' | 'localId'>>;
    }
  | {
      readonly type: 'draft/target';
      readonly conversationId: string;
      readonly target: FollowUpTarget | null;
    }
  /** A saved draft read from storage; ignored when the conversation already has one in memory. */
  | { readonly type: 'draft/restored'; readonly conversationId: string; readonly draft: Draft }
  | { readonly type: 'composer/context'; readonly context: ComposerContext }
  | {
      readonly type: 'composer/targets';
      readonly epoch: number;
      readonly conversationId: string;
      readonly targets: readonly TargetTask[];
      readonly key: string;
    }
  /** An error that did not come from a send (file pre-check, routing refusals). */
  | { readonly type: 'composer/error'; readonly reason: string }
  | { readonly type: 'task-draft/open'; readonly draft: TaskDraft }
  | { readonly type: 'task-draft/edit'; readonly patch: Partial<TaskDraft> }
  | { readonly type: 'task-draft/close' }
  | { readonly type: 'task-draft/starting'; readonly starting: boolean }
  | { readonly type: 'task-draft/started'; readonly conversationId: string };

type ComposerHandlers = Pick<Handlers, ComposerAction['type']>;

const putDraft = (state: WorkspaceState, id: string, draft: Draft): WorkspaceState => ({
  ...state,
  drafts: { ...state.drafts, [id]: draft },
});

const dropDraft = (state: WorkspaceState, id: string): WorkspaceState =>
  id in state.drafts
    ? {
        ...state,
        drafts: Object.fromEntries(Object.entries(state.drafts).filter(([k]) => k !== id)),
      }
    : state;

const withComposer = (
  state: WorkspaceState,
  patch: Partial<WorkspaceState['composer']>,
): WorkspaceState => ({ ...state, composer: { ...state.composer, ...patch } });

function chipAdd(
  state: WorkspaceState,
  { conversationId, chip, mint }: Extract<ComposerAction, { type: 'draft/chip-add' }>,
): WorkspaceState {
  const had = draftOf(state, conversationId);
  const key = chipKey(chip);
  if (had.chips.some((c) => chipKey(c) === key)) return state;
  return putDraft(state, conversationId, {
    ...had,
    chips: [...had.chips, chip],
    clientRequestId: had.clientRequestId ?? mint,
  });
}

function chipRemove(
  state: WorkspaceState,
  { conversationId, key }: Extract<ComposerAction, { type: 'draft/chip-remove' }>,
): WorkspaceState {
  const had = draftOf(state, conversationId);
  const chips = had.chips.filter((c) => chipKey(c) !== key);
  if (chips.length === had.chips.length) return state;
  const next = { ...had, chips };
  return next.text === '' && chips.length === 0 && next.target === null
    ? dropDraft(state, conversationId)
    : putDraft(state, conversationId, next);
}

function filePatch(
  state: WorkspaceState,
  { conversationId, localId, patch }: Extract<ComposerAction, { type: 'draft/file' }>,
): WorkspaceState {
  const had = draftOf(state, conversationId);
  const chip = had.chips.find((c) => c.kind === 'file' && c.localId === localId);
  if (chip === undefined || chip.kind !== 'file') return state;
  const chips = had.chips.map((c) => (c === chip ? { ...chip, ...patch } : c));
  return putDraft(state, conversationId, { ...had, chips });
}

function setTarget(
  state: WorkspaceState,
  { conversationId, target }: Extract<ComposerAction, { type: 'draft/target' }>,
): WorkspaceState {
  const had = draftOf(state, conversationId);
  if (had.target === target) return state;
  const next = { ...had, target };
  return next.text === '' && next.chips.length === 0 && target === null
    ? dropDraft(state, conversationId)
    : putDraft(state, conversationId, next);
}

function restored(
  state: WorkspaceState,
  { conversationId, draft }: Extract<ComposerAction, { type: 'draft/restored' }>,
): WorkspaceState {
  return conversationId in state.drafts ? state : putDraft(state, conversationId, draft);
}

function targets(
  state: WorkspaceState,
  action: Extract<ComposerAction, { type: 'composer/targets' }>,
): WorkspaceState {
  if (state.conversation?.id !== action.conversationId) return state;
  return withComposer(state, { targets: action.targets, targetsKey: action.key });
}

function started(
  state: WorkspaceState,
  { conversationId }: Extract<ComposerAction, { type: 'task-draft/started' }>,
): WorkspaceState {
  return dropDraft(
    withComposer(state, { taskDraft: null, starting: false, error: null }),
    conversationId,
  );
}

export const COMPOSER_HANDLERS: ComposerHandlers = {
  'draft/chip-add': chipAdd,
  'draft/chip-remove': chipRemove,
  'draft/file': filePatch,
  'draft/target': setTarget,
  'draft/restored': restored,
  'composer/context': (state, { context }) => withComposer(state, { context }),
  'composer/targets': targets,
  'composer/error': (state, { reason }) =>
    state.composer.error === reason ? state : withComposer(state, { error: reason }),
  'task-draft/open': (state, { draft }) =>
    withComposer(state, { taskDraft: draft, starting: false, error: null }),
  'task-draft/edit': (state, { patch }) =>
    state.composer.taskDraft === null
      ? state
      : withComposer(state, { taskDraft: { ...state.composer.taskDraft, ...patch } }),
  'task-draft/close': (state) =>
    state.composer.taskDraft === null
      ? state
      : withComposer(state, { taskDraft: null, starting: false }),
  'task-draft/starting': (state, { starting }) =>
    state.composer.starting === starting ? state : withComposer(state, { starting, error: null }),
  'task-draft/started': started,
};
