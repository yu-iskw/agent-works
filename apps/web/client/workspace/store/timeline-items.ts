import { dayLabel, dayOf } from './time.js';

import type { MessageView } from '@agent-works/domain/teamwork';

const GROUP_WINDOW_MS = 5 * 60_000;

export type TimelineItem =
  | { readonly kind: 'day'; readonly id: string; readonly label: string }
  | {
      readonly kind: 'message';
      readonly id: string;
      readonly message: MessageView;
      /** The previous bubble was the same voice within a few minutes, so the author line is hidden. */
      readonly grouped: boolean;
    };

/** Day separators plus messages, with stable content-free ids so keyed rendering keeps DOM nodes. */
export function timelineItems(
  messages: readonly MessageView[],
  now: Date,
): readonly TimelineItem[] {
  const items: TimelineItem[] = [];
  let day = '';
  let previous: MessageView | undefined;
  for (const message of messages) {
    const messageDay = dayOf(message.at);
    if (messageDay !== day) {
      day = messageDay;
      items.push({ kind: 'day', id: `day:${day}`, label: dayLabel(day, now) });
      previous = undefined;
    }
    const grouped =
      previous !== undefined &&
      previous.role === message.role &&
      message.role !== 'system' &&
      Date.parse(message.at) - Date.parse(previous.at) < GROUP_WINDOW_MS;
    items.push({ kind: 'message', id: `msg:${message.id}`, message, grouped });
    previous = message;
  }
  return items;
}
