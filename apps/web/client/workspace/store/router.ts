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

/**
 * Entries this island pushed carry how many in-app pushes precede them in this document, so
 * Back only walks browser history it created itself. A deep link (or any entry the island only
 * replaced) has depth 0 and goes back by replacing the URL, never by leaving the app.
 */
const depthOf = (state: unknown): number => {
  if (typeof state !== 'object' || state === null) return 0;
  const { aw, depth } = state as { aw?: unknown; depth?: unknown };
  return aw === true && typeof depth === 'number' ? depth : 0;
};
const mark = (depth: number) => ({ aw: true, depth }) as const;

export function createRouter(deps: RouterDeps): Router {
  const navigate = (route: Route, mode: 'push' | 'replace' = 'push'): void => {
    const url = formatRoute(route);
    const depth = depthOf(deps.history.state);
    if (mode === 'push') deps.history.pushState(mark(depth + 1), '', url);
    else deps.history.replaceState(mark(depth), '', url);
    deps.dispatch({ type: 'route/changed', route });
  };
  return {
    navigate,
    back: (current) => {
      if (depthOf(deps.history.state) > 0) {
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
