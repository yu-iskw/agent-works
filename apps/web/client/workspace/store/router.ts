// The only writer of browser history. Entries this router pushes carry `{ aw: true }`, so Back
// from a panel knows whether the previous entry is ours or the page the member came from.

import { conversationRoute, formatRoute, parseRoute } from '../../../shared/route.js';

import type { Action } from './actions.js';
import type { Route } from '../../../shared/route.js';

export type HistoryLike = {
  readonly state: unknown;
  pushState(data: unknown, unused: string, url: string): void;
  replaceState(data: unknown, unused: string, url: string): void;
  back(): void;
};

export type RouterDeps = {
  readonly dispatch: (action: Action) => void;
  readonly history: HistoryLike;
  readonly location: () => { readonly pathname: string; readonly search: string };
  readonly onPopState: (handler: () => void) => void;
};

export type Router = {
  readonly navigate: (route: Route, mode?: 'push' | 'replace') => void;
  readonly back: (current: Route) => void;
  readonly start: () => void;
};

const MARK = { aw: true } as const;

const ours = (state: unknown): boolean =>
  typeof state === 'object' && state !== null && (state as { aw?: unknown }).aw === true;

export function createRouter(deps: RouterDeps): Router {
  const navigate = (route: Route, mode: 'push' | 'replace' = 'push'): void => {
    const url = formatRoute(route);
    if (mode === 'push') deps.history.pushState(MARK, '', url);
    else deps.history.replaceState(MARK, '', url);
    deps.dispatch({ type: 'route/changed', route });
  };
  return {
    navigate,
    back: (current) => {
      if (ours(deps.history.state)) {
        deps.history.back();
        return;
      }
      navigate(
        current.teammate === null
          ? { ...current, panel: { kind: 'none' } }
          : conversationRoute(current.segment, current.teammate),
        'replace',
      );
    },
    start: () =>
      deps.onPopState(() => {
        const { pathname, search } = deps.location();
        const route = parseRoute(pathname, search);
        if (route !== undefined) deps.dispatch({ type: 'route/changed', route });
      }),
  };
}
