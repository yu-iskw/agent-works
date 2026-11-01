// The workspace state: one record of slices. The reducer returns the same slice reference when a
// slice did not change, so a signal per slice stays quiet during polls that bring nothing new.

import type { ListsState } from './lists.js';
import type { ReviewState } from './review-state.js';
import type { TasksState } from './task-state.js';
import type {
  ComposerContext,
  ContextChip,
  FollowUpTarget,
  TargetTask,
  TaskDraft,
} from '../../../shared/composer.js';
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
  /** Context chips (files, teammates, skills, sources); persisted with the text. */
  readonly chips: readonly ContextChip[];
  /** The member's explicit follow-up target; null means the computed default. */
  readonly target: FollowUpTarget | null;
};

export const isEmptyDraft = (draft: Draft): boolean =>
  draft.text === '' && draft.chips.length === 0 && draft.target === null;

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
  /** Bounded Work, Results and Inbox lists; each keeps its own query, pages and selection. */
  readonly lists: ListsState;
  readonly conversation: ConversationState | null;
  readonly drafts: Readonly<Record<string, Draft>>;
  readonly composer: ComposerState;
  readonly panel: { readonly width: number };
  readonly net: { readonly failures: number; readonly offline: boolean };
  readonly notice: BootNotice | null;
  /** Task details for cards and panels, keyed by task id. */
  readonly tasks: TasksState;
  /** Panel expansion and remembered reading positions. */
  readonly review: ReviewState;
};

export const EMPTY_DRAFT: Draft = { text: '', clientRequestId: null, chips: [], target: null };

/**
 * Composer facts beyond the draft: the send in flight, the last error, the menu context (loaded
 * once per document), follow-up targets for the open conversation, and the local task draft card.
 */
export type ComposerState = {
  readonly sending: string | null;
  readonly error: string | null;
  readonly context: ComposerContext | null;
  readonly targets: readonly TargetTask[];
  /** `<conversationId>:<taskId>@<version>,...` the targets were computed for; a change refetches. */
  readonly targetsKey: string;
  readonly taskDraft: TaskDraft | null;
  readonly starting: boolean;
};

export const EMPTY_COMPOSER: ComposerState = {
  sending: null,
  error: null,
  context: null,
  targets: [],
  targetsKey: '',
  taskDraft: null,
  starting: false,
};

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
