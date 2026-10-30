// One pure reducer, organised as a table keyed by action type so every action has exactly one
// handler and the compiler checks the table is complete. Handlers return the same state reference
// when nothing changed, which keeps the per-slice signals quiet during polls.

import { DEFAULT_PREFERENCES, PANEL_WIDTH } from '../../../shared/contract.js';
import { sameConversation } from '../../../shared/route.js';

import { EMPTY_DRAFT, compareMessages, conversationFromPage } from './state.js';

import type { Action } from './actions.js';
import type { ConversationState, Draft, Layout, WorkspaceState } from './state.js';
import type { Bootstrap, LinkedTask, SidebarTab } from '../../../shared/contract.js';
import type { MessageView } from '@agent-works/domain/teamwork';

const NO_SCROLL: Readonly<Record<SidebarTab, number>> = { teammates: 0, work: 0, results: 0 };

const clampWidth = (width: number): number =>
  Number.isFinite(width)
    ? Math.min(PANEL_WIDTH.max, Math.max(PANEL_WIDTH.min, Math.round(width)))
    : DEFAULT_PREFERENCES.panelWidth;

/** Sorted insert with dedupe by id; returns the same array when nothing was new. */
export function mergeMessages(
  current: readonly MessageView[],
  incoming: readonly MessageView[],
): { readonly messages: readonly MessageView[]; readonly added: readonly MessageView[] } {
  const known = new Set(current.map((m) => m.id));
  const added = incoming.filter((m) => (known.has(m.id) ? false : (known.add(m.id), true)));
  if (added.length === 0) return { messages: current, added };
  return { messages: [...current, ...added].sort(compareMessages), added };
}

const sameTasks = (had: readonly LinkedTask[], now: readonly LinkedTask[]): boolean =>
  had.length === now.length &&
  now.every((task, i) => {
    const before = had.at(i);
    return before !== undefined && before.id === task.id && before.version === task.version;
  });

function appended(
  conversation: ConversationState,
  action: Extract<Action, { type: 'conversation/appended' }>,
): ConversationState {
  const { page } = action;
  const { messages, added } = mergeMessages(conversation.messages, page.messages);
  const nextCursor = page.nextCursor ?? conversation.nextCursor;
  const tasksSame = sameTasks(conversation.tasks, page.tasks);
  if (
    added.length === 0 &&
    page.reply === conversation.reply &&
    nextCursor === conversation.nextCursor &&
    tasksSame
  )
    return conversation;
  const arrivals = added.filter((m) => m.role !== 'member').length;
  return {
    ...conversation,
    messages,
    nextCursor,
    prevCursor: page.prevCursor ?? conversation.prevCursor,
    reply: page.reply,
    tasks: tasksSame ? conversation.tasks : page.tasks,
    unseen: conversation.follow ? 0 : conversation.unseen + arrivals,
  };
}

const withConversation = (state: WorkspaceState, next: ConversationState | null): WorkspaceState =>
  next === state.conversation ? state : { ...state, conversation: next };

// Draft keys are conversation uuids from the segment, read from a plain record.
// eslint-disable-next-line security/detect-object-injection
const draftOf = (state: WorkspaceState, id: string): Draft => state.drafts[id] ?? EMPTY_DRAFT;

function withDraft(state: WorkspaceState, id: string, draft: Draft | null): WorkspaceState {
  if (draft === null) {
    if (!(id in state.drafts)) return state;
    return {
      ...state,
      drafts: Object.fromEntries(Object.entries(state.drafts).filter(([key]) => key !== id)),
    };
  }
  const had = draftOf(state, id);
  if (had.text === draft.text && had.clientRequestId === draft.clientRequestId) return state;
  return { ...state, drafts: { ...state.drafts, [id]: draft } };
}

const withSidebar = (
  state: WorkspaceState,
  patch: Partial<WorkspaceState['sidebar']>,
): WorkspaceState => ({ ...state, sidebar: { ...state.sidebar, ...patch } });

const withComposer = (
  state: WorkspaceState,
  composer: WorkspaceState['composer'],
): WorkspaceState => ({ ...state, composer });

type Handlers = {
  readonly [K in Action['type']]: (
    state: WorkspaceState,
    action: Extract<Action, { type: K }>,
  ) => WorkspaceState;
};

const HANDLERS: Handlers = {
  'route/changed': (state, { route }) => {
    if (sameConversation(state.route, route))
      return state.route === route ? state : { ...state, route };
    return {
      ...state,
      route,
      epoch: state.epoch + 1,
      conversation: null,
      composer: { sending: null, error: null },
    };
  },
  'layout/changed': (state, { layout }) => (state.layout === layout ? state : { ...state, layout }),
  'sidebar/tab': (state, { tab }) =>
    state.sidebar.tab === tab ? state : withSidebar(state, { tab }),
  'sidebar/search': (state, { text }) =>
    state.sidebar.search === text ? state : withSidebar(state, { search: text }),
  'sidebar/scroll': (state, { tab, top }) =>
    // `tab` is the closed SidebarTab enum.
    // eslint-disable-next-line security/detect-object-injection
    state.sidebar.scroll[tab] === top
      ? state
      : withSidebar(state, { scroll: { ...state.sidebar.scroll, [tab]: top } }),
  'sidebar/loaded': (state, { page, at }) => withSidebar(state, { teammates: page, loadedAt: at }),
  'conversation/loaded': (state, { page }) => withConversation(state, conversationFromPage(page)),
  'conversation/appended': (state, action) => {
    const conversation = state.conversation;
    return conversation === null || conversation.id !== action.page.id
      ? state
      : withConversation(state, appended(conversation, action));
  },
  'conversation/follow': (state, { follow }) => {
    const conversation = state.conversation;
    if (conversation === null || conversation.follow === follow) return state;
    return withConversation(state, {
      ...conversation,
      follow,
      unseen: follow ? 0 : conversation.unseen,
    });
  },
  'conversation/seen': (state) => {
    const conversation = state.conversation;
    return conversation === null || (conversation.unseen === 0 && conversation.follow)
      ? state
      : withConversation(state, { ...conversation, follow: true, unseen: 0 });
  },
  'draft/text': (state, { conversationId, text, mint }) => {
    if (text === '') return withDraft(state, conversationId, null);
    const had = draftOf(state, conversationId);
    return withDraft(state, conversationId, { text, clientRequestId: had.clientRequestId ?? mint });
  },
  'composer/sending': (state, { clientRequestId }) =>
    state.composer.sending !== null
      ? state
      : withComposer(state, { sending: clientRequestId, error: null }),
  'composer/sent': (state, { conversationId }) =>
    withDraft(withComposer(state, { sending: null, error: null }), conversationId, null),
  'composer/failed': (state, { reason }) => withComposer(state, { sending: null, error: reason }),
  'composer/clear-error': (state) =>
    state.composer.error === null ? state : withComposer(state, { ...state.composer, error: null }),
  'panel/width': (state, { width }) => {
    const clamped = clampWidth(width);
    return state.panel.width === clamped ? state : { ...state, panel: { width: clamped } };
  },
  'prefs/loaded': (state, { prefs }) => ({
    ...state,
    prefs,
    panel: { width: clampWidth(prefs.panelWidth) },
  }),
  'me/loaded': (state, { me }) => ({ ...state, me }),
  'net/failure': (state) => ({
    ...state,
    net: { failures: state.net.failures + 1, offline: true },
  }),
  'net/ok': (state) =>
    state.net.failures === 0 && !state.net.offline
      ? state
      : { ...state, net: { failures: 0, offline: false } },
  'notice/dismiss': (state) => (state.notice === null ? state : { ...state, notice: null }),
};

type AnyHandler = (state: WorkspaceState, action: Action) => WorkspaceState;

/** Pure. A result tagged with an older epoch is dropped whole; otherwise one handler runs. */
export function reduce(state: WorkspaceState, action: Action): WorkspaceState {
  if ('epoch' in action && action.epoch !== state.epoch) return state;
  // The table is keyed by the action union's own discriminant, so the lookup is closed.
  return (HANDLERS[action.type] as AnyHandler)(state, action);
}

export function initial(bootstrap: Bootstrap, layout: Layout, now: number): WorkspaceState {
  const base: WorkspaceState = {
    scope: bootstrap.scope,
    epoch: 1,
    route: bootstrap.route,
    layout,
    me: bootstrap.me,
    prefs: bootstrap.prefs,
    sidebar: {
      tab: bootstrap.prefs.lastContext?.tab ?? 'teammates',
      search: '',
      scroll: NO_SCROLL,
      teammates: { segment: bootstrap.scope.segment, items: [], nextCursor: null },
      loadedAt: 0,
    },
    conversation: null,
    drafts: {},
    composer: { sending: null, error: null },
    panel: { width: clampWidth(bootstrap.prefs.panelWidth) },
    net: { failures: 0, offline: false },
    notice: bootstrap.notice,
  };
  const withTeam = reduce(base, {
    type: 'sidebar/loaded',
    epoch: 1,
    page: bootstrap.teammates,
    at: now,
  });
  return bootstrap.conversation === null
    ? withTeam
    : reduce(withTeam, { type: 'conversation/loaded', epoch: 1, page: bootstrap.conversation });
}
