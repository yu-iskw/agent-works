import type { ComposerAction } from './composer-reducer.js';
import type { ListName, ListsState } from './lists.js';
import type { Layout } from './state.js';
import type {
  ConversationPage,
  MeView,
  Preferences,
  SidebarTab,
  TaskDetailPage,
  TaskFilter,
  TeammatesPage,
} from '../../../shared/contract.js';
import type { Route } from '../../../shared/route.js';

export type Action =
  | { readonly type: 'route/changed'; readonly route: Route }
  | { readonly type: 'layout/changed'; readonly layout: Layout }
  | { readonly type: 'sidebar/tab'; readonly tab: SidebarTab }
  | { readonly type: 'sidebar/search'; readonly text: string }
  | { readonly type: 'sidebar/scroll'; readonly tab: SidebarTab; readonly top: number }
  | {
      readonly type: 'sidebar/loaded';
      readonly epoch: number;
      readonly page: TeammatesPage;
      readonly at: number;
    }
  | {
      readonly type: 'conversation/loaded';
      readonly epoch: number;
      readonly page: ConversationPage;
    }
  | {
      readonly type: 'conversation/appended';
      readonly epoch: number;
      readonly page: ConversationPage;
    }
  | {
      /** An older page from `before`; it moves only `prevCursor`, never the polling cursor. */
      readonly type: 'conversation/earlier';
      readonly epoch: number;
      readonly page: ConversationPage;
    }
  | { readonly type: 'conversation/follow'; readonly follow: boolean }
  | { readonly type: 'conversation/seen' }
  | {
      readonly type: 'draft/text';
      readonly conversationId: string;
      readonly text: string;
      /** A fresh id the reducer adopts only when the draft had none; keeps the reducer pure. */
      readonly mint: string;
    }
  | { readonly type: 'composer/sending'; readonly clientRequestId: string }
  | { readonly type: 'composer/sent'; readonly conversationId: string }
  | { readonly type: 'composer/failed'; readonly reason: string }
  | { readonly type: 'composer/clear-error' }
  | { readonly type: 'panel/width'; readonly width: number }
  | { readonly type: 'prefs/loaded'; readonly prefs: Preferences }
  | { readonly type: 'me/loaded'; readonly me: MeView }
  | { readonly type: 'net/failure' }
  | { readonly type: 'net/ok' }
  | { readonly type: 'notice/dismiss' }
  | { readonly type: 'task/loading'; readonly taskId: string }
  | { readonly type: 'task/loaded'; readonly epoch: number; readonly detail: TaskDetailPage }
  | { readonly type: 'task/failed'; readonly taskId: string; readonly error: string }
  | { readonly type: 'review/expand'; readonly expanded: boolean }
  | { readonly type: 'review/position'; readonly key: string; readonly top: number }
  /** The member read this conversation; its row drops Unread and New result at once. */
  | { readonly type: 'sidebar/read'; readonly conversationId: string }
  | { readonly type: 'work/filter'; readonly filter: TaskFilter }
  | { readonly type: 'list/query'; readonly list: 'work' | 'results'; readonly q: string }
  | { readonly type: 'list/reset'; readonly list: ListName }
  | { readonly type: 'list/loading'; readonly list: ListName; readonly generation: number }
  | {
      readonly [K in ListName]: {
        readonly type: 'list/loaded';
        readonly list: K;
        readonly generation: number;
        readonly page: {
          readonly items: ListsState[K]['items'];
          readonly nextCursor: string | null;
        };
      };
    }[ListName]
  | { readonly type: 'list/failed'; readonly list: ListName; readonly generation: number }
  | { readonly type: 'list/select'; readonly list: ListName; readonly key: string | null }
  | ComposerAction;
