import { EMPTY_DRAFT } from './state.js';
import { taskDetail } from './task-state.js';

import type { Draft, WorkspaceState } from './state.js';
import type { InboxRow, TeammateRow } from '../../../shared/contract.js';

export function activeTeammate(state: WorkspaceState): TeammateRow | undefined {
  const id = state.route.teammate;
  return id === null ? undefined : state.sidebar.teammates.items.find((row) => row.id === id);
}

export function activeDraft(state: WorkspaceState): Draft {
  const id = state.conversation?.id;
  // Draft keys are conversation uuids from the segment, read from a plain record.
  // eslint-disable-next-line security/detect-object-injection
  return id === undefined ? EMPTY_DRAFT : (state.drafts[id] ?? EMPTY_DRAFT);
}

export const panelOpen = (state: WorkspaceState): boolean => state.route.panel.kind !== 'none';

/** A task's title from its loaded detail, else from the conversation's linked tasks. */
export function taskTitle(
  state: Pick<WorkspaceState, 'tasks' | 'conversation'>,
  taskId: string,
): string | undefined {
  return (
    taskDetail(state.tasks, taskId)?.task.title ??
    state.conversation?.tasks.find((task) => task.id === taskId)?.title
  );
}

/** Client-side filter over the loaded rows; the segment list is bounded, not the filter. */
export function visibleTeammates(state: WorkspaceState): readonly TeammateRow[] {
  const needle = state.sidebar.search.trim().toLowerCase();
  const rows = state.sidebar.teammates.items;
  return needle === ''
    ? rows
    : rows.filter(
        (row) => row.name.toLowerCase().includes(needle) || row.role.toLowerCase().includes(needle),
      );
}

export const teammateById = (
  state: WorkspaceState,
  id: string | null | undefined,
): TeammateRow | undefined =>
  id === null || id === undefined
    ? undefined
    : state.sidebar.teammates.items.find((row) => row.id === id);

/**
 * The teammate whose conversation shows a task: the conversation it was started from, else its
 * result owner. `undefined` when both are gone (archived teammate), so callers fall back safely.
 */
export function teammateForTask(
  state: WorkspaceState,
  task: { readonly conversationId: string | null; readonly resultOwner: string },
): TeammateRow | undefined {
  const rows = state.sidebar.teammates.items;
  return (
    (task.conversationId === null
      ? undefined
      : rows.find((row) => row.conversationId === task.conversationId)) ??
    rows.find((row) => row.id === task.resultOwner)
  );
}

const DECISION_KINDS: ReadonlySet<InboxRow['kind']> = new Set<InboxRow['kind']>([
  'question',
  'plan_review',
  'approval',
  'failed',
  'uncertain',
]);

/** The inbox in its two groups; order within a group is the server's (newest first). */
export function groupInbox(items: readonly InboxRow[]): {
  readonly decisions: readonly InboxRow[];
  readonly results: readonly InboxRow[];
} {
  return {
    decisions: items.filter((item) => DECISION_KINDS.has(item.kind)),
    results: items.filter((item) => !DECISION_KINDS.has(item.kind)),
  };
}
