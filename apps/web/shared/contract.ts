// The BFF contract between app/workspace (server) and client/workspace (browser). Types only, no
// zod: the server parses segment responses and browser requests at its boundary, the client
// trusts BFF JSON by type. Paths are built here so both sides agree on the route table.

import type { MemberTag } from './member-tag.js';
import type { Route } from './route.js';
import type { MessageView, TaskSummary } from '@agent-works/domain/teamwork';

export const BOOTSTRAP_ID = 'aw-bootstrap';
export const MOUNT_ID = 'workspace';
export const CSRF_HEADER = 'x-csrf-token';

export const THEMES = ['system', 'light', 'dark'] as const;
export const STARTUPS = ['last', 'inbox', 'recap'] as const;
export const SEND_KEYS = ['enter', 'mod-enter'] as const;
export const SIDEBAR_TABS = ['teammates', 'work', 'results'] as const;
export const AVATAR_IDS = [
  'leaf',
  'sun',
  'moon',
  'wave',
  'spark',
  'stone',
  'bloom',
  'orbit',
] as const;
export const ACCENT_IDS = ['mint', 'amber', 'lavender', 'blue', 'coral', 'slate'] as const;

export type Theme = (typeof THEMES)[number];
type Startup = (typeof STARTUPS)[number];
export type SendKey = (typeof SEND_KEYS)[number];
export type SidebarTab = (typeof SIDEBAR_TABS)[number];
export type AvatarId = (typeof AVATAR_IDS)[number];
export type AccentId = (typeof ACCENT_IDS)[number];

export const PANEL_WIDTH = { min: 320, max: 1600, default: 480 } as const;

type LastContext = { readonly teammateId: string; readonly tab: SidebarTab };

/** Member scope (theme, startup, sendKey, panelWidth) plus this segment's lastContext. */
export type Preferences = {
  readonly theme: Theme;
  readonly startup: Startup;
  readonly sendKey: SendKey;
  readonly panelWidth: number;
  readonly lastContext: LastContext | null;
};

export const DEFAULT_PREFERENCES: Preferences = {
  theme: 'system',
  startup: 'last',
  sendKey: 'enter',
  panelWidth: PANEL_WIDTH.default,
  lastContext: null,
};

export type PreferencesPatch = Partial<Preferences>;

export type Appearance = { readonly avatar: AvatarId | null; readonly accent: AccentId | null };

type LastMessage = {
  readonly role: MessageView['role'];
  readonly text: string;
  readonly at: string;
};

/**
 * One sidebar row. The activity fields come from the segment's teammate listing when it carries
 * them and fall back to quiet defaults when it does not, so the sidebar degrades instead of failing.
 */
export type TeammateRow = {
  readonly id: string;
  readonly name: string;
  readonly role: string;
  readonly conversationId: string;
  readonly appearance: Appearance;
  readonly lastMessage: LastMessage | null;
  /** A teammate or system message after the member's read marker. */
  readonly unread: boolean;
  /** A linked task is in progress or a reply is pending. */
  readonly working: boolean;
  /** An open decision on a linked task. */
  readonly needsAttention: boolean;
  /** A result card after the read marker. */
  readonly unreadResult: boolean;
  readonly updatedAt: string;
};

export type TeammatesPage = {
  readonly segment: string;
  readonly items: readonly TeammateRow[];
  readonly nextCursor: string | null;
};

/** `queued` and `generating` both mean a reply row is pending; the words come from the server. */
export type ReplyState = 'none' | 'queued' | 'generating';

export type LinkedTask = {
  readonly id: string;
  readonly version: number;
  readonly status: TaskSummary['status'];
  readonly title: string;
};

export type ConversationPage = {
  readonly segment: string;
  readonly id: string;
  readonly teammateId: string;
  readonly messages: readonly MessageView[];
  /** Pass as `after` on the next poll; null when the segment cannot page (then every poll is full). */
  readonly nextCursor: string | null;
  /** Set when older messages exist before this page. */
  readonly prevCursor: string | null;
  readonly reply: ReplyState;
  readonly tasks: readonly LinkedTask[];
};

/** `segment` (the id) is the JSON envelope's echo; the display name travels separately. */
export type MeView = {
  readonly segment: string;
  readonly segmentName: string;
  readonly segments: readonly { readonly id: string; readonly name: string }[];
  readonly member: { readonly email: string; readonly name: string };
  readonly identity: 'google' | 'local-test';
  readonly sourceMode: 'live' | 'fixture';
  readonly model: {
    readonly modelId: string;
    readonly mode: 'vertex' | 'stub';
    readonly state: 'ready' | 'unverified' | 'error';
    readonly callsUsed: number;
    readonly callsLimit: number;
  };
  readonly readOnly: boolean;
  readonly inboxOpen: number;
};

export type BootNotice =
  | { readonly code: 'remembered_teammate_gone' }
  | { readonly code: 'no_teammates' }
  | { readonly code: 'segment_unavailable'; readonly error: string };

/** Everything the first paint needs; embedded as non-executing JSON in the shell document. */
export type Bootstrap = {
  readonly scope: {
    readonly memberTag: MemberTag;
    readonly segment: string;
    readonly csrf: string;
  };
  readonly route: Route;
  readonly me: MeView;
  readonly prefs: Preferences;
  readonly teammates: TeammatesPage;
  readonly conversation: ConversationPage | null;
  readonly notice: BootNotice | null;
  /** The server-rendered page for the same context, for noscript and the Details placeholder. */
  readonly fallbackHref: string;
};

/** JSON routes under `/api/s/<seg>/`. Every reply echoes `segment`. */
export const api = {
  me: (segment: string) => `/api/s/${segment}/me`,
  teammates: (segment: string) => `/api/s/${segment}/teammates`,
  /** `teammate` lets the BFF fall back to the teammate page while the segment cannot page. */
  conversation: (
    segment: string,
    conversationId: string,
    teammateId: string,
    after: string | null = null,
  ) =>
    `/api/s/${segment}/conversations/${conversationId}?teammate=${teammateId}${after === null ? '' : `&after=${encodeURIComponent(after)}`}`,
  messages: (segment: string, conversationId: string) =>
    `/api/s/${segment}/conversations/${conversationId}/messages`,
  preferences: (segment: string) => `/api/s/${segment}/preferences`,
} as const;

/** Server-rendered pages the workspace links to while their panels are not built. */
export const pages = {
  segment: (segment: string) => `/s/${segment}`,
  inbox: (segment: string) => `/s/${segment}/inbox`,
  teammates: (segment: string) => `/s/${segment}/teammates`,
  teammateFallback: (segment: string, teammateId: string) =>
    `/s/${segment}/pages/teammates/${teammateId}`,
  catalog: (segment: string) => `/s/${segment}/catalog`,
  connections: (segment: string) => `/s/${segment}/connections`,
  tasks: (segment: string) => `/s/${segment}/tasks`,
  task: (segment: string, taskId: string) => `/s/${segment}/tasks/${taskId}`,
  newTask: (segment: string, conversationId: string) =>
    `/s/${segment}/tasks/new?conversationId=${conversationId}`,
  signOut: '/auth/sign-out',
} as const;
