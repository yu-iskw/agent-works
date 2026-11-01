// Panel width and expansion. Width moves in the store on every drag or key press and is written
// to the member's preferences once the gesture ends, so a drag never floods the BFF.

import { api as paths } from '../../../shared/contract.js';

import type { Api } from '../api.js';
import type { Store } from './store.js';
import type { Preferences } from '../../../shared/contract.js';

export type PanelEffects = {
  readonly setWidth: (width: number) => void;
  /** Persists the current width as the member's desktop preference. */
  readonly commitWidth: () => Promise<void>;
  readonly expand: (expanded: boolean) => void;
  readonly remember: (key: string, top: number) => void;
};

type PreferencesReply = Preferences & { readonly segment: string };

export function createPanelEffects(deps: {
  readonly store: Store;
  readonly api: Api;
}): PanelEffects {
  const { store, api } = deps;
  const segment = store.peek().scope.segment;
  let lastCommitted = store.peek().prefs.panelWidth;
  return {
    setWidth: (width) => store.dispatch({ type: 'panel/width', width }),
    commitWidth: async () => {
      const width = store.peek().panel.width;
      if (width === lastCommitted) return;
      lastCommitted = width;
      try {
        const saved = await api.post<PreferencesReply>(paths.preferences(segment), {
          panelWidth: width,
        });
        const had = store.peek().prefs;
        if (had.panelWidth !== saved.panelWidth)
          store.dispatch({ type: 'prefs/loaded', prefs: { ...had, panelWidth: saved.panelWidth } });
      } catch {
        lastCommitted = -1;
      }
    },
    expand: (expanded) => store.dispatch({ type: 'review/expand', expanded }),
    remember: (key, top) => store.dispatch({ type: 'review/position', key, top }),
  };
}
