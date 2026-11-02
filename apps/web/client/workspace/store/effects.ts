// Everything with a side effect: polling, fetch dispatch, draft persistence, preference writes,
// theme and layout. The reducer stays pure; this module is the only caller of `api` and `drafts`.

import { effect } from '@preact/signals';

import { api as paths } from '../../../shared/contract.js';
import { conversationRoute, formatRoute } from '../../../shared/route.js';
import { SegmentMismatch } from '../api.js';

import { createComposerEffects } from './composer-effects.js';
import { createListEffects } from './list-effects.js';
import { createPanelEffects } from './panel-effects.js';
import { readMarkerTarget } from './read-marker.js';
import { nextDelay } from './scheduler.js';
import { createTaskEffects } from './task-effects.js';

import type { ComposerEffects } from './composer-effects.js';
import type { Api } from '../api.js';
import type { DraftStore } from '../storage.js';
import type { IdentityEffects, ListEffects } from './list-effects.js';
import type { PanelEffects } from './panel-effects.js';
import type { ReadTarget } from './read-marker.js';
import type { Router } from './router.js';
import type { Layout } from './state.js';
import type { Store } from './store.js';
import type { TaskEffects } from './task-effects.js';
import type {
  ConversationPage,
  Preferences,
  PreferencesPatch,
  SidebarTab,
  Theme,
} from '../../../shared/contract.js';
import type { Route } from '../../../shared/route.js';

export type EffectsDeps = {
  readonly store: Store;
  readonly api: Api;
  readonly router: Router;
  readonly drafts: DraftStore;
  readonly clock: {
    readonly setTimeout: (run: () => void, ms: number) => unknown;
    readonly clearTimeout: (handle: unknown) => void;
  };
  readonly mintId: () => string;
  readonly hidden: () => boolean;
  readonly onVisibility: (handler: () => void) => void;
  readonly applyTheme: (theme: Theme) => void;
  readonly watchLayout: (handler: (layout: Layout) => void) => void;
  /** Full navigation for a conversation the loaded sidebar cannot resolve. */
  readonly assign: (url: string) => void;
  /** Decodes a member file as text (FileReader in the browser). */
  readonly readText: (file: File) => Promise<string>;
};

export type Effects = {
  readonly start: () => () => void;
  readonly pollNow: () => Promise<void>;
  readonly loadEarlier: () => Promise<void>;
  readonly setDraft: (text: string) => void;
  readonly setTab: (tab: SidebarTab) => void;
  readonly setTheme: (theme: Theme) => Promise<void>;
  readonly open: (route: Route) => void;
  readonly back: () => void;
  readonly beforeSignOut: () => void;
  /** Task detail fetches and task commands (cards and review panels). */
  readonly tasks: TaskEffects;
  /** Panel width, expansion and remembered reading positions. */
  readonly panel: PanelEffects;
  readonly setPrefs: (patch: PreferencesPatch) => Promise<void>;
  /** Bounded Work, Results and Inbox lists, the sidebar refresh and the recap. */
  readonly lists: ListEffects;
  /** The teammate identity editor. */
  readonly identity: IdentityEffects;
} & ComposerEffects;

const DRAFT_DEBOUNCE_MS = 300;
const CONTEXT_DEBOUNCE_MS = 500;
const SEARCH_DEBOUNCE_MS = 300;
const READ_DEBOUNCE_MS = 400;
/** Sidebar rows (working, unread, needs you) refresh on this cadence while the tab is visible. */
const SIDEBAR_REFRESH_MS = 15_000;

/** Trailing debounce; `flush` runs the pending call now (before the page unloads). */
function debounce(clock: EffectsDeps['clock'], ms: number) {
  let handle: unknown;
  let pending: (() => void) | null = null;
  const later = (run: () => void) => {
    pending = run;
    clock.clearTimeout(handle);
    handle = clock.setTimeout(() => {
      pending = null;
      run();
    }, ms);
  };
  later.flush = () => {
    const run = pending;
    if (run === null) return;
    pending = null;
    clock.clearTimeout(handle);
    run();
  };
  return later;
}

type PreferencesReply = Preferences & { readonly segment: string };

const preferencesOf = (reply: PreferencesReply): Preferences => ({
  theme: reply.theme,
  startup: reply.startup,
  sendKey: reply.sendKey,
  panelWidth: reply.panelWidth,
  lastContext: reply.lastContext,
});

export function createEffects(deps: EffectsDeps): Effects {
  const { store, api, router, drafts, clock } = deps;
  const { dispatch, peek } = store;
  const segment = peek().scope.segment;
  let pollHandle: unknown;
  let inFlight = false;
  const tasks = createTaskEffects({ store, api });
  const panel = createPanelEffects({ store, api });

  const loadPrefs = (prefs: Preferences) => dispatch({ type: 'prefs/loaded', prefs });

  /** A reply for another segment is dropped silently; anything else counts as connection trouble. */
  const netFailure = (error: unknown): void => {
    if (!(error instanceof SegmentMismatch)) dispatch({ type: 'net/failure' });
  };

  async function pollNow(): Promise<void> {
    const state = peek();
    const conversation = state.conversation;
    if (conversation === null || inFlight) return;
    inFlight = true;
    const { epoch } = state;
    try {
      const page = await api.get<ConversationPage>(
        paths.conversation(segment, conversation.id, conversation.teammateId, {
          after: conversation.nextCursor,
        }),
      );
      dispatch({ type: 'conversation/appended', epoch, page });
      dispatch({ type: 'net/ok' });
    } catch (error) {
      netFailure(error);
    } finally {
      inFlight = false;
    }
  }

  /** The page before the oldest message held, so a long conversation can be read from the start. */
  async function loadEarlier(): Promise<void> {
    const state = peek();
    const conversation = state.conversation;
    if (conversation === null || conversation.prevCursor === null) return;
    const { epoch } = state;
    try {
      const page = await api.get<ConversationPage>(
        paths.conversation(segment, conversation.id, conversation.teammateId, {
          before: conversation.prevCursor,
        }),
      );
      dispatch({ type: 'conversation/earlier', epoch, page });
    } catch (error) {
      netFailure(error);
    }
  }

  function schedule(): void {
    clock.clearTimeout(pollHandle);
    const delay = nextDelay(peek().net.failures, deps.hidden());
    if (delay === null) return;
    pollHandle = clock.setTimeout(() => {
      void pollNow().then(schedule);
    }, delay);
  }

  function restoreDraft(conversationId: string): void {
    if (conversationId in peek().drafts) return;
    const saved = drafts.readDraft(conversationId);
    if (saved !== undefined)
      dispatch({
        type: 'draft/restored',
        conversationId,
        draft: { ...saved, clientRequestId: saved.clientRequestId ?? deps.mintId() },
      });
  }

  async function loadConversation(route: Route): Promise<void> {
    const state = peek();
    // The server already answered this URL with a missing panel; reloading it would loop.
    if (route.panel.kind === 'missing') return;
    const row = state.sidebar.teammates.items.find((t) => t.id === route.teammate);
    if (row === undefined) {
      deps.assign(formatRoute(route));
      return;
    }
    const { epoch } = state;
    try {
      const page = await api.get<ConversationPage>(
        paths.conversation(segment, row.conversationId, row.id),
      );
      dispatch({ type: 'conversation/loaded', epoch, page });
      dispatch({ type: 'net/ok' });
      restoreDraft(page.id);
    } catch (error) {
      netFailure(error);
    }
  }

  const persistDraft = debounce(clock, DRAFT_DEBOUNCE_MS);
  const persistContext = debounce(clock, CONTEXT_DEBOUNCE_MS);
  const readLater = debounce(clock, READ_DEBOUNCE_MS);
  let lastRead: ReadTarget | null = null;
  let sidebarHandle: unknown;
  const { lists, identity } = createListEffects({
    store,
    api,
    router,
    debounce: debounce(clock, SEARCH_DEBOUNCE_MS),
  });

  function scheduleSidebar(): void {
    clock.clearTimeout(sidebarHandle);
    if (deps.hidden()) return;
    sidebarHandle = clock.setTimeout(() => {
      void lists.refreshTeammates().then(scheduleSidebar);
    }, SIDEBAR_REFRESH_MS);
  }

  function postRead(target: ReadTarget): void {
    lastRead = target;
    void api
      .post(paths.read(segment, target.conversationId), { upToMessageId: target.upToMessageId })
      .then(() => dispatch({ type: 'sidebar/read', conversationId: target.conversationId }))
      .catch(() => {
        if (lastRead === target) lastRead = null;
      });
  }

  function start(): () => void {
    const stops = [
      tasks.start(),
      effect(() => {
        deps.applyTheme(store.prefs.value.theme);
      }),
      effect(() => {
        const route = store.route.value;
        if (route.teammate !== null && store.conversation.value === null)
          void loadConversation(route);
      }),
      effect(() => {
        const conversation = store.conversation.value;
        const mine = conversation === null ? undefined : store.drafts.value[conversation.id];
        if (conversation === null) return;
        persistDraft(() => drafts.writeDraft(conversation.id, mine ?? null));
      }),
      effect(() => {
        const target = readMarkerTarget(store.conversation.value, deps.hidden(), lastRead);
        if (target !== null) readLater(() => postRead(target));
      }),
      effect(() => {
        const teammateId = store.route.value.teammate;
        const tab = store.sidebar.value.tab;
        if (teammateId === null) return;
        persistContext(() => {
          void api
            .post<PreferencesReply>(paths.preferences(segment), {
              lastContext: { teammateId, tab },
            })
            .catch(() => undefined);
        });
      }),
    ];
    stops.push(composer.start());
    deps.watchLayout((layout) => dispatch({ type: 'layout/changed', layout }));
    deps.onVisibility(() => {
      persistDraft.flush();
      schedule();
      scheduleSidebar();
      const target = readMarkerTarget(peek().conversation, deps.hidden(), lastRead);
      if (target !== null) readLater(() => postRead(target));
    });
    router.start();
    const current = peek().conversation;
    if (current !== null) restoreDraft(current.id);
    schedule();
    scheduleSidebar();
    return () => {
      clock.clearTimeout(pollHandle);
      clock.clearTimeout(sidebarHandle);
      for (const stop of stops) stop();
    };
  }

  /** Applies at once, persists, and rolls back when the segment refuses. */
  async function setPrefs(patch: PreferencesPatch): Promise<void> {
    const had = peek().prefs;
    loadPrefs({ ...had, ...patch });
    try {
      const saved = await api.post<PreferencesReply>(paths.preferences(segment), patch);
      loadPrefs(preferencesOf(saved));
    } catch {
      loadPrefs(had);
    }
  }

  const setTheme = (theme: Theme): Promise<void> => setPrefs({ theme });

  const composer = createComposerEffects({ deps, pollNow, readText: deps.readText });

  return {
    ...composer,
    start,
    pollNow,
    loadEarlier,
    setDraft: (text) => {
      const conversation = peek().conversation;
      if (conversation !== null)
        dispatch({
          type: 'draft/text',
          conversationId: conversation.id,
          text,
          mint: deps.mintId(),
        });
    },
    setTab: (tab) => dispatch({ type: 'sidebar/tab', tab }),
    setTheme,
    open: (route) => router.navigate(route),
    back: () => router.back(peek().route),
    tasks,
    panel,
    beforeSignOut: () => {
      drafts.signOut();
    },
    setPrefs,
    lists,
    identity,
  };
}

export const closePanel = (route: Route): Route =>
  route.teammate === null ? route : conversationRoute(route.segment, route.teammate);
