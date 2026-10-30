import { EMPTY_DRAFT } from './state.js';

import type { Draft, WorkspaceState } from './state.js';
import type { TeammateRow } from '../../../shared/contract.js';

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
