// Bounded lists (Work, Results, Inbox) share one shape and one reducer. A list's `generation`
// bumps whenever its query changes; a page that arrives for an older generation is dropped, so a
// slow search reply cannot land in a list that has since been reset.

import type { InboxRow, ResultRow, TaskFilter, TaskRow } from '../../../shared/contract.js';

type ListStatus = 'idle' | 'loading' | 'ready' | 'error';

export type ListState<T> = {
  readonly generation: number;
  readonly items: readonly T[];
  readonly nextCursor: string | null;
  readonly status: ListStatus;
  /** The row key the member last opened from this list; kept across tab switches. */
  readonly selected: string | null;
};

export type ListsState = {
  readonly work: ListState<TaskRow> & { readonly filter: TaskFilter; readonly q: string };
  readonly results: ListState<ResultRow> & { readonly q: string };
  readonly inbox: ListState<InboxRow>;
};

export type ListName = keyof ListsState;
export type ListRow = TaskRow | ResultRow | InboxRow;

export const resultKey = (row: { readonly taskId: string; readonly revision: number }): string =>
  `${row.taskId}:${row.revision}`;

/** The identity of a row in any list: a result is one revision of a task, the rest carry an id. */
export const rowKey = (row: ListRow): string => ('revision' in row ? resultKey(row) : row.id);

const empty = <T>(): ListState<T> => ({
  generation: 1,
  items: [],
  nextCursor: null,
  status: 'idle',
  selected: null,
});

export const EMPTY_LISTS: ListsState = {
  work: { ...empty<TaskRow>(), filter: 'all', q: '' },
  results: { ...empty<ResultRow>(), q: '' },
  inbox: empty<InboxRow>(),
};

// The helpers are generic over the whole list record (`L`), so a list's own query fields
// (`filter`, `q`) survive every transition.

/** A new query: forget the rows and cursor, keep the selection, move to the next generation. */
export function resetList<L extends ListState<unknown>>(list: L): L {
  return {
    ...list,
    generation: list.generation + 1,
    items: [],
    nextCursor: null,
    status: 'idle',
  };
}

export function listLoading<L extends ListState<unknown>>(list: L, generation: number): L {
  if (generation !== list.generation || list.status === 'loading') return list;
  return { ...list, status: 'loading' };
}

export function listFailed<L extends ListState<unknown>>(list: L, generation: number): L {
  if (generation !== list.generation) return list;
  return { ...list, status: 'error' };
}

/** Appends a page without duplicates and adopts its cursor; a stale generation is ignored. */
export function listLoaded<L extends ListState<unknown>>(
  list: L,
  generation: number,
  page: { readonly items: L['items']; readonly nextCursor: string | null },
  keyOf: (row: L['items'][number]) => string,
): L {
  if (generation !== list.generation) return list;
  const known = new Set(list.items.map(keyOf));
  const fresh = page.items.filter((row) =>
    known.has(keyOf(row)) ? false : (known.add(keyOf(row)), true),
  );
  return {
    ...list,
    items: fresh.length === 0 ? list.items : [...list.items, ...fresh],
    nextCursor: page.nextCursor,
    status: 'ready',
  };
}

export function listSelect<L extends ListState<unknown>>(list: L, selected: string | null): L {
  return list.selected === selected ? list : { ...list, selected };
}
