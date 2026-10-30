import type { Layout } from './state.js';
import type {
  ConversationPage,
  MeView,
  Preferences,
  SidebarTab,
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
  | { readonly type: 'notice/dismiss' };
