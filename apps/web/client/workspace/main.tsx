import { render } from 'preact';

import { BOOTSTRAP_ID, MOUNT_ID, pages } from '../../shared/contract.js';

import { createApi } from './api.js';
import { browserStorage, createDraftStore } from './storage.js';
import { createEffects } from './store/effects.js';
import { initial } from './store/reducer.js';
import { createRouter } from './store/router.js';
import { createStore } from './store/store.js';
import { WorkspaceContext } from './ui/context.js';
import { Shell } from './ui/shell.jsx';

import './workspace.css';

import type { Layout } from './store/state.js';
import type { Bootstrap, Theme } from '../../shared/contract.js';

const PHONE = window.matchMedia('(max-width: 640px)');
const TABLET = window.matchMedia('(max-width: 1024px)');

const layoutNow = (): Layout => (PHONE.matches ? 'phone' : TABLET.matches ? 'tablet' : 'desktop');

function applyTheme(theme: Theme): void {
  if (theme === 'system') delete document.documentElement.dataset.theme;
  else document.documentElement.dataset.theme = theme;
}

function readBootstrap(): Bootstrap | undefined {
  const tag = document.getElementById(BOOTSTRAP_ID);
  if (tag === null) return undefined;
  try {
    return JSON.parse(tag.textContent) as Bootstrap;
  } catch {
    return undefined;
  }
}

function boot(): void {
  const mount = document.getElementById(MOUNT_ID);
  if (mount === null) return;
  const bootstrap = readBootstrap();
  if (bootstrap === undefined) {
    const link = mount.querySelector('noscript a')?.getAttribute('href');
    mount.replaceChildren();
    const p = document.createElement('p');
    p.className = 'boot';
    p.append('The workspace could not start. ');
    const a = document.createElement('a');
    a.href = link ?? '/';
    a.textContent = 'Open the page version';
    p.append(a);
    mount.append(p);
    return;
  }
  const drafts = createDraftStore(
    bootstrap.scope.memberTag,
    bootstrap.scope.segment,
    browserStorage,
  );
  drafts.purgeOthers();
  const store = createStore(initial(bootstrap, layoutNow(), Date.now()));
  const api = createApi({
    scope: bootstrap.scope,
    fetch: (input, init) => fetch(input, init),
    onUnauthenticated: () => window.location.assign('/sign-in'),
  });
  const router = createRouter({
    dispatch: store.dispatch,
    history: window.history,
    location: () => ({ pathname: window.location.pathname, search: window.location.search }),
    onPopState: (handler) => window.addEventListener('popstate', handler),
  });
  const effects = createEffects({
    store,
    api,
    router,
    drafts,
    clock: {
      setTimeout: (run, ms) => window.setTimeout(run, ms),
      clearTimeout: (handle) => window.clearTimeout(handle as number | undefined),
    },
    mintId: () => crypto.randomUUID(),
    hidden: () => document.hidden,
    onVisibility: (handler) => document.addEventListener('visibilitychange', handler),
    applyTheme,
    watchLayout: (handler) => {
      const update = () => handler(layoutNow());
      PHONE.addEventListener('change', update);
      TABLET.addEventListener('change', update);
    },
    assign: (url) => window.location.assign(url),
  });
  window.history.replaceState({ aw: true }, '', window.location.href);
  mount.replaceChildren();
  render(
    <WorkspaceContext.Provider value={{ store, effects }}>
      <Shell />
    </WorkspaceContext.Provider>,
    mount,
  );
  effects.start();
  if (bootstrap.route.teammate === null && bootstrap.notice === null)
    window.location.assign(pages.segment(bootstrap.scope.segment));
}

boot();
