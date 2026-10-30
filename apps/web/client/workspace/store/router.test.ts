import { describe, expect, it } from 'vitest';

import { conversationRoute } from '../../../shared/route.js';

import { createRouter } from './router.js';

import type { Action } from './actions.js';
import type { HistoryLike } from './router.js';

const T = '11111111-2222-4333-8444-555555555555';

function fakeHistory(initialState: unknown = null) {
  const entries: { readonly op: string; readonly url: string }[] = [];
  let state = initialState;
  let popHandler: (() => void) | undefined;
  let url = `/s/alpha/teammates/${T}`;
  const history: HistoryLike = {
    get state() {
      return state;
    },
    pushState: (data, _unused, next) => {
      state = data;
      url = next;
      entries.push({ op: 'push', url: next });
    },
    replaceState: (data, _unused, next) => {
      state = data;
      url = next;
      entries.push({ op: 'replace', url: next });
    },
    back: () => entries.push({ op: 'back', url }),
  };
  const actions: Action[] = [];
  const router = createRouter({
    dispatch: (action) => actions.push(action),
    history,
    location: () => ({
      pathname: url.split('?')[0] ?? url,
      search: url.includes('?') ? url.slice(url.indexOf('?')) : '',
    }),
    onPopState: (handler) => {
      popHandler = handler;
    },
  });
  return {
    router,
    entries,
    actions,
    pop: (next: string) => {
      url = next;
      popHandler?.();
    },
  };
}

describe('router', () => {
  it('pushes the formatted route and dispatches route/changed once', () => {
    const { router, entries, actions } = fakeHistory();
    const route = { ...conversationRoute('alpha', T), panel: { kind: 'teammate' as const } };
    router.navigate(route);
    expect(entries).toEqual([{ op: 'push', url: `/s/alpha/teammates/${T}/details` }]);
    expect(actions).toEqual([{ type: 'route/changed', route }]);
  });

  it('goes back through history when the previous entry is ours', () => {
    const { router, entries, actions } = fakeHistory();
    router.navigate({ ...conversationRoute('alpha', T), panel: { kind: 'inbox' } });
    router.back(conversationRoute('alpha', T));
    expect(entries.at(-1)?.op).toBe('back');
    expect(actions).toHaveLength(1);
  });

  it('replaces with the bare conversation when the member arrived by deep link', () => {
    const { router, entries, actions } = fakeHistory(null);
    const open = { ...conversationRoute('alpha', T), panel: { kind: 'teammate' as const } };
    router.back(open);
    expect(entries).toEqual([{ op: 'replace', url: `/s/alpha/teammates/${T}` }]);
    expect(actions).toEqual([{ type: 'route/changed', route: conversationRoute('alpha', T) }]);
  });

  it('turns popstate into a parsed route and ignores non-workspace urls', () => {
    const { router, actions, pop } = fakeHistory();
    router.start();
    pop(`/s/alpha/teammates/${T}/inbox?surface=work`);
    expect(actions).toEqual([
      {
        type: 'route/changed',
        route: { segment: 'alpha', teammate: T, surface: 'work', panel: { kind: 'inbox' } },
      },
    ]);
    pop('/s/alpha/catalog');
    expect(actions).toHaveLength(1);
  });
});
