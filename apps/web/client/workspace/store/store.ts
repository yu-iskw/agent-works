import { computed, signal } from '@preact/signals';

import { reduce } from './reducer.js';

import type { Action } from './actions.js';
import type { WorkspaceState } from './state.js';
import type { ReadonlySignal } from '@preact/signals';

type Slices = {
  readonly [K in keyof WorkspaceState]: ReadonlySignal<WorkspaceState[K]>;
};

export type Store = Slices & {
  readonly state: ReadonlySignal<WorkspaceState>;
  readonly dispatch: (action: Action) => void;
  readonly peek: () => WorkspaceState;
};

/** One signal for the whole record, one computed per slice; slices only notify when their reference moves. */
export function createStore(initialState: WorkspaceState): Store {
  const state = signal(initialState);
  const dispatch = (action: Action): void => {
    const next = reduce(state.peek(), action);
    if (next !== state.peek()) state.value = next;
  };
  const slices = Object.fromEntries(
    (Object.keys(initialState) as (keyof WorkspaceState)[]).map((key) => [
      key,
      // `key` ranges over keyof WorkspaceState.
      // eslint-disable-next-line security/detect-object-injection
      computed(() => state.value[key]),
    ]),
  ) as Slices;
  return { ...slices, state, dispatch, peek: () => state.peek() };
}
