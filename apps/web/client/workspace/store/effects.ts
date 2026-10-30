// Everything with a side effect: polling, fetch dispatch, draft persistence, preference writes,
// theme and layout. The reducer stays pure; this module is the only caller of `api` and `drafts`.

import { effect } from '@preact/signals';

import { api as paths } from '../../../shared/contract.js';
import { conversationRoute, formatRoute } from '../../../shared/route.js';
import { ApiFailure, SegmentMismatch } from '../api.js';

import { nextDelay } from './scheduler.js';
import { activeDraft } from './selectors.js';

import type { Api } from '../api.js';
import type { DraftStore } from '../storage.js';
import type { Router } from './router.js';
import type { Layout } from './state.js';
import type { Store } from './store.js';
import type { ConversationPage, Preferences, SidebarTab, Theme } from '../../../shared/contract.js';
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
};

export type Effects = {
  readonly start: () => () => void;
  readonly pollNow: () => Promise<void>;
  readonly send: () => Promise<void>;
  readonly setDraft: (text: string) => void;
  readonly setTab: (tab: SidebarTab) => void;
  readonly setTheme: (theme: Theme) => Promise<void>;
  readonly open: (route: Route) => void;
  readonly back: () => void;
  readonly beforeSignOut: () => void;
};

const DRAFT_DEBOUNCE_MS = 300;
const CONTEXT_DEBOUNCE_MS = 500;

function failureText(error: unknown): string {
  if (error instanceof ApiFailure && error.code === 'reply_pending')
    return 'Wait for the reply before sending again.';
  const code = error instanceof ApiFailure ? ` (${error.code})` : '';
  return `Could not send${code}. Your message is kept; try again.`;
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

  const debounce = (ms: number) => {
    let handle: unknown;
    return (run: () => void) => {
      clock.clearTimeout(handle);
      handle = clock.setTimeout(run, ms);
    };
  };

  const loadPrefs = (prefs: Preferences) => dispatch({ type: 'prefs/loaded', prefs });

  async function pollNow(): Promise<void> {
    const state = peek();
    const conversation = state.conversation;
    if (conversation === null || inFlight) return;
    inFlight = true;
    const { epoch } = state;
    try {
      const page = await api.get<ConversationPage>(
        paths.conversation(
          segment,
          conversation.id,
          conversation.teammateId,
          conversation.nextCursor,
        ),
      );
      dispatch({ type: 'conversation/appended', epoch, page });
      dispatch({ type: 'net/ok' });
    } catch (error) {
      if (!(error instanceof SegmentMismatch)) dispatch({ type: 'net/failure' });
    } finally {
      inFlight = false;
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
        type: 'draft/text',
        conversationId,
        text: saved.text,
        mint: saved.clientRequestId ?? deps.mintId(),
      });
  }

  async function loadConversation(route: Route): Promise<void> {
    const state = peek();
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
      if (!(error instanceof SegmentMismatch)) dispatch({ type: 'net/failure' });
    }
  }

  const persistDraft = debounce(DRAFT_DEBOUNCE_MS);
  const persistContext = debounce(CONTEXT_DEBOUNCE_MS);

  function start(): () => void {
    const stops = [
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
    deps.watchLayout((layout) => dispatch({ type: 'layout/changed', layout }));
    deps.onVisibility(schedule);
    router.start();
    const current = peek().conversation;
    if (current !== null) restoreDraft(current.id);
    schedule();
    return () => {
      clock.clearTimeout(pollHandle);
      for (const stop of stops) stop();
    };
  }

  async function send(): Promise<void> {
    const state = peek();
    const conversation = state.conversation;
    const draft = activeDraft(state);
    if (
      conversation === null ||
      state.composer.sending !== null ||
      draft.clientRequestId === null ||
      draft.text.trim() === ''
    )
      return;
    const { clientRequestId } = draft;
    dispatch({ type: 'composer/sending', clientRequestId });
    try {
      await api.post(paths.messages(segment, conversation.id), {
        clientRequestId,
        text: draft.text,
      });
      dispatch({ type: 'composer/sent', conversationId: conversation.id });
      drafts.writeDraft(conversation.id, null);
      await pollNow();
    } catch (error) {
      dispatch({ type: 'composer/failed', reason: failureText(error) });
    }
  }

  async function setTheme(theme: Theme): Promise<void> {
    const had = peek().prefs;
    loadPrefs({ ...had, theme });
    try {
      const saved = await api.post<PreferencesReply>(paths.preferences(segment), { theme });
      loadPrefs(preferencesOf(saved));
    } catch {
      loadPrefs(had);
    }
  }

  return {
    start,
    pollNow,
    send,
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
    beforeSignOut: () => {
      drafts.clearMine();
    },
  };
}

export const closePanel = (route: Route): Route =>
  route.teammate === null ? route : conversationRoute(route.segment, route.teammate);
