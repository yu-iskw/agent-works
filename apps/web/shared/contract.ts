// The BFF contract between app/workspace (server) and client/workspace (browser). Types only, no
// zod: the server parses segment responses and browser requests at its boundary, the client
// trusts BFF JSON by type. Paths are built here so both sides agree on the route table.

import type { MemberTag } from './member-tag.js';
import type { Route } from './route.js';
import type {
  CapabilityState,
  InboxItem,
  MessageView,
  ResultEntry,
  TaskDetail,
  TaskListStatus,
  TaskSummary,
} from '@agent-works/domain/teamwork';

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
/** Work tab filters; the same words the segment's task list accepts as `status`. */
export const TASK_FILTERS = [
  'all',
  'running',
  'attention',
  'completed',
] as const satisfies readonly TaskListStatus[];
const LIST_LIMIT = 25;

export type Theme = (typeof THEMES)[number];
export type Startup = (typeof STARTUPS)[number];
export type TaskFilter = (typeof TASK_FILTERS)[number];
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

/** One page of a bounded list; `nextCursor` goes back as `cursor` to load the next page. */
export type ListPage<T> = {
  readonly segment: string;
  readonly items: readonly T[];
  readonly nextCursor: string | null;
};

export type TaskRow = TaskSummary;
export type ResultRow = ResultEntry;
export type InboxRow = InboxItem;

export type ListQuery = {
  readonly q?: string;
  readonly cursor?: string | null;
  readonly limit?: number;
};

/** A skill the member can attach to a teammate: the catalog's latest version plus attachment state. */
export type SkillOption = {
  readonly id: string;
  readonly version: number;
  readonly name: string;
  readonly summary: string;
  readonly origin: 'curated' | 'private' | 'imported';
  readonly attached: boolean;
};

/** What the identity editor needs; capabilities are the effective intersection, read-only here. */
export type TeammateDetail = {
  readonly segment: string;
  readonly id: string;
  readonly version: number;
  readonly name: string;
  readonly role: string;
  readonly appearance: Appearance;
  readonly template: { readonly id: string; readonly version: number; readonly name: string };
  readonly origin: 'template' | 'imported';
  readonly skills: readonly SkillOption[];
  readonly capabilities: readonly CapabilityState[];
};

export type TeammateIdentityPatch = {
  readonly expectedVersion: number;
  readonly name: string;
  readonly role: string;
  readonly avatar: AvatarId | null;
  readonly accent: AccentId | null;
};

export type SkillPatch = {
  readonly skillId: string;
  readonly version: number;
  readonly attach: boolean;
};

/** The coordinator recap: grounded in persisted inbox and task state, never a model call. */
export type RecapView = {
  readonly segment: string;
  readonly decisions: readonly InboxItem[];
  readonly running: readonly TaskSummary[];
  readonly results: readonly ResultEntry[];
  readonly counts: { readonly decisions: number; readonly running: number };
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

/** Task commands the BFF forwards to `POST /tasks/:id/<command>`; bodies are validated per command. */
export const TASK_COMMANDS = [
  'plan/decision',
  'plan/edit',
  'plan/replan',
  'follow-up',
  'missing',
  'cancel',
  'retry',
  'reconcile',
  'publish',
  'action',
] as const;
export type TaskCommand = (typeof TASK_COMMANDS)[number];

/** `GET /api/s/<seg>/tasks/<id>`: the segment's task detail with the BFF segment echo. */
export type TaskDetailPage = Omit<TaskDetail, 'apiVersion'>;

/** `POST /api/s/<seg>/tasks/<id>/<command>`: the task row after the command. */
export type TaskCommandReply = { readonly segment: string; readonly task: TaskSummary };

/** JSON routes under `/api/s/<seg>/`. Every reply echoes `segment`. */
export const api = {
  me: (segment: string) => `/api/s/${segment}/me`,
  task: (segment: string, taskId: string) => `/api/s/${segment}/tasks/${taskId}`,
  taskCommand: (segment: string, taskId: string, command: TaskCommand) =>
    `/api/s/${segment}/tasks/${taskId}/${command}`,
  attachment: (segment: string, attachmentId: string) =>
    `/api/s/${segment}/attachments/${attachmentId}`,
  teammates: (segment: string) => `/api/s/${segment}/teammates`,
  /** `teammate` lets the BFF fall back to the teammate page while the segment cannot page. */
  conversation: (
    segment: string,
    conversationId: string,
    teammateId: string,
    cursor: { readonly after?: string | null; readonly before?: string | null } = {},
  ) => {
    const page =
      cursor.after != null
        ? `&after=${encodeURIComponent(cursor.after)}`
        : cursor.before != null
          ? `&before=${encodeURIComponent(cursor.before)}`
          : '';
    return `/api/s/${segment}/conversations/${conversationId}?teammate=${teammateId}${page}`;
  },
  messages: (segment: string, conversationId: string) =>
    `/api/s/${segment}/conversations/${conversationId}/messages`,
  preferences: (segment: string) => `/api/s/${segment}/preferences`,
  read: (segment: string, conversationId: string) =>
    `/api/s/${segment}/conversations/${conversationId}/read`,
  tasks: (segment: string, query: ListQuery & { readonly status?: TaskFilter }) =>
    `/api/s/${segment}/tasks${listSearch({ status: query.status ?? 'all', ...query })}`,
  results: (segment: string, query: ListQuery) => `/api/s/${segment}/results${listSearch(query)}`,
  inbox: (segment: string, query: ListQuery) => `/api/s/${segment}/inbox${listSearch(query)}`,
  recap: (segment: string) => `/api/s/${segment}/recap`,
  teammate: (segment: string, teammateId: string) => `/api/s/${segment}/teammates/${teammateId}`,
  teammateSkills: (segment: string, teammateId: string) =>
    `/api/s/${segment}/teammates/${teammateId}/skills`,
  /** Menu context for the composer: teammates with capabilities, catalog skills, allowed sources. */
  composer: (segment: string) => `/api/s/${segment}/composer`,
  /** Follow-up targets for the linked tasks of a conversation (`tasks` is a comma-separated id list). */
  targets: (segment: string, conversationId: string, taskIds: readonly string[]) =>
    `/api/s/${segment}/conversations/${conversationId}/targets?tasks=${taskIds.join(',')}`,
  attachments: (segment: string, conversationId: string) =>
    `/api/s/${segment}/conversations/${conversationId}/attachments`,
  attachmentRemove: (segment: string, attachmentId: string) =>
    `/api/s/${segment}/attachments/${attachmentId}/remove`,
  createTask: (segment: string) => `/api/s/${segment}/tasks`,
} as const;

function listSearch(query: ListQuery & { readonly status?: TaskFilter }): string {
  const params = new URLSearchParams();
  if (query.status !== undefined && query.status !== 'all') params.set('status', query.status);
  if (query.q !== undefined && query.q.trim() !== '') params.set('q', query.q.trim());
  if (query.cursor !== undefined && query.cursor !== null) params.set('cursor', query.cursor);
  params.set('limit', String(query.limit ?? LIST_LIMIT));
  return `?${params.toString()}`;
}

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
  teammateExport: (segment: string, teammateId: string) =>
    `/s/${segment}/teammates/${teammateId}/export`,
  newTask: (segment: string, conversationId: string) =>
    `/s/${segment}/tasks/new?conversationId=${conversationId}`,
  signOut: '/auth/sign-out',
} as const;
