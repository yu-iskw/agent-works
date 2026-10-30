// The workspace state: one record of slices. The reducer returns the same slice reference when a
// slice did not change, so a signal per slice stays quiet during polls that bring nothing new.

import type {
  BootNotice,
  ConversationPage,
  LinkedTask,
  MeView,
  Preferences,
  ReplyState,
  SidebarTab,
  TeammatesPage,
} from '../../../shared/contract.js';
import type { MemberTag } from '../../../shared/member-tag.js';
import type { Route } from '../../../shared/route.js';
import type { MessageView } from '@agent-works/domain/teamwork';

export type Layout = 'desktop' | 'tablet' | 'phone';

export type Scope = {
  readonly memberTag: MemberTag;
  readonly segment: string;
  readonly csrf: string;
};

export type ConversationState = {
  readonly id: string;
  readonly teammateId: string;
  /** Sorted by (at, id) and unique by id, so a reconnect can neither duplicate nor reorder. */
  readonly messages: readonly MessageView[];
  readonly nextCursor: string | null;
  readonly prevCursor: string | null;
  readonly reply: ReplyState;
  readonly tasks: readonly LinkedTask[];
  /** True while the member reads near the bottom; new activity then scrolls into view. */
  readonly follow: boolean;
  /** Messages that arrived while not following; shown on the New activity control. */
  readonly unseen: number;
};

export type Draft = {
  readonly text: string;
  /** Minted when the draft first becomes non-empty and reused on retry, so the segment dedupes. */
  readonly clientRequestId: string | null;
};

type SidebarState = {
  readonly tab: SidebarTab;
  readonly search: string;
  readonly scroll: Readonly<Record<SidebarTab, number>>;
  readonly teammates: TeammatesPage;
  readonly loadedAt: number;
};

export type WorkspaceState = {
  readonly scope: Scope;
  /** Bumps whenever the conversation changes; results tagged with an older epoch are dropped. */
  readonly epoch: number;
  readonly route: Route;
  readonly layout: Layout;
  readonly me: MeView;
  readonly prefs: Preferences;
  readonly sidebar: SidebarState;
  readonly conversation: ConversationState | null;
  readonly drafts: Readonly<Record<string, Draft>>;
  readonly composer: { readonly sending: string | null; readonly error: string | null };
  readonly panel: { readonly width: number };
  readonly net: { readonly failures: number; readonly offline: boolean };
  readonly notice: BootNotice | null;
};

export const EMPTY_DRAFT: Draft = { text: '', clientRequestId: null };

export function conversationFromPage(page: ConversationPage): ConversationState {
  return {
    id: page.id,
    teammateId: page.teammateId,
    messages: sortMessages(dedupe(page.messages)),
    nextCursor: page.nextCursor,
    prevCursor: page.prevCursor,
    reply: page.reply,
    tasks: page.tasks,
    follow: true,
    unseen: 0,
  };
}

export const compareMessages = (a: MessageView, b: MessageView): number =>
  a.at < b.at ? -1 : a.at > b.at ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0;

const sortMessages = (messages: readonly MessageView[]): readonly MessageView[] =>
  [...messages].sort(compareMessages);

function dedupe(messages: readonly MessageView[]): readonly MessageView[] {
  const seen = new Set<string>();
  return messages.filter((m) => (seen.has(m.id) ? false : (seen.add(m.id), true)));
}
