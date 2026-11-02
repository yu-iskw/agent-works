import { useEffect, useLayoutEffect, useRef, useState } from 'preact/hooks';

import { nearBottom } from '../store/anchoring.js';
import { activeTeammate, panelOpen, teammateById } from '../store/selectors.js';
import { clockTime, dayLabel } from '../store/time.js';
import { timelineOf, timelineSettled } from '../store/timeline-select.js';

import { Avatar, initialsOf } from './avatars.jsx';
import { CardItem } from './cards/card.jsx';
import { ContributionItem } from './cards/contribution.jsx';
import { TaskDraftCard } from './cards/task-draft-card.jsx';
import { useWorkspace } from './context.js';
import { Markdown } from './markdown.js';

import type { TeammateRow } from '../../../shared/contract.js';
import type { ConversationState, WorkspaceState } from '../store/state.js';
import type { TimelineItem } from '@agent-works/domain/teamwork-timeline';
import type { JSX } from 'preact';

type MessageItem = Extract<TimelineItem, { kind: 'message' }>;

function Initials(props: { readonly name: string; readonly member: boolean }): JSX.Element {
  return (
    <span
      class={props.member ? 'avatar avatar-member' : 'avatar'}
      data-accent={props.member ? undefined : 'slate'}
      role="img"
      aria-label={props.name}
    >
      <span aria-hidden="true">{initialsOf(props.name)}</span>
    </span>
  );
}

type Voice = {
  readonly mine: boolean;
  readonly name: string;
  readonly teammate: TeammateRow | undefined;
};

function voiceOf(item: MessageItem, state: WorkspaceState): Voice {
  if (item.author.kind === 'member') return { mine: true, name: 'You', teammate: undefined };
  if (item.author.kind === 'system') return { mine: false, name: 'System', teammate: undefined };
  const teammate = teammateById(state, item.author.id);
  return { mine: false, name: teammate?.name ?? item.author.name, teammate };
}

function BubbleAvatar(props: { readonly voice: Voice; readonly memberName: string }) {
  const { voice } = props;
  if (voice.mine) return <Initials name={props.memberName} member />;
  if (voice.teammate === undefined) return <Initials name={voice.name} member={false} />;
  const { appearance, id, name } = voice.teammate;
  return <Avatar appearance={appearance} id={id} name={name} size={32} />;
}

function Bubble(props: {
  readonly item: MessageItem;
  readonly state: WorkspaceState;
}): JSX.Element {
  const { item, state } = props;
  const voice = voiceOf(item, state);
  const { mine, name } = voice;
  const stamp = <time dateTime={item.at}>{clockTime(item.at)}</time>;
  return (
    <li
      class={`msg ${mine ? 'msg-member' : 'msg-teammate'}${item.grouped ? ' msg-grouped' : ''}`}
      id={item.id}
    >
      <span class="msg-avatar">
        {item.grouped ? null : <BubbleAvatar voice={voice} memberName={state.me.member.name} />}
      </span>
      <div class="msg-body">
        {item.grouped ? null : (
          <span class="msg-meta">
            <span class="msg-author">{name}</span>
            {stamp}
          </span>
        )}
        <div class="bubble">
          {mine ? <p class="msg-text">{item.text}</p> : <Markdown text={item.text} />}
          {item.grouped ? <span class="msg-stamp">{stamp}</span> : null}
        </div>
      </div>
    </li>
  );
}

function SystemLine(props: {
  readonly item: Extract<TimelineItem, { kind: 'system' }>;
}): JSX.Element {
  return (
    <li class="sys" id={props.item.id}>
      <span class="sys-mark" aria-hidden="true" />
      <span>
        <span class="visually-hidden">System activity: </span>
        {props.item.text}
      </span>
      <time dateTime={props.item.at}>{clockTime(props.item.at)}</time>
    </li>
  );
}

function ReplyStatus(props: {
  readonly conversation: ConversationState;
  readonly name: string;
}): JSX.Element | null {
  const { reply } = props.conversation;
  if (reply === 'none') return null;
  return (
    <p class="reply" role="status">
      {reply === 'queued' ? (
        `Waiting for ${props.name}'s reply`
      ) : (
        <>
          {props.name} is replying
          <span class="dots" aria-hidden="true">
            <i />
            <i />
            <i />
          </span>
        </>
      )}
    </p>
  );
}

function Empty(props: { readonly text: string; readonly alert?: boolean }): JSX.Element {
  return (
    <div class="tl tl-empty" role={props.alert === true ? 'alert' : undefined}>
      <p>{props.text}</p>
    </div>
  );
}

function Item(props: {
  readonly item: TimelineItem;
  readonly state: WorkspaceState;
  readonly now: Date;
}): JSX.Element {
  const { item, state } = props;
  switch (item.kind) {
    case 'day':
      return (
        <li class="day">
          <span>{dayLabel(item.date, props.now)}</span>
        </li>
      );
    case 'message':
      return <Bubble item={item} state={state} />;
    case 'system':
      return <SystemLine item={item} />;
    case 'contribution':
      return <ContributionItem item={item} />;
    case 'card':
      return <CardItem item={item} />;
  }
}

/**
 * Keeps the reading position while the list is hidden and shown again (tablet panel, expanded
 * panel, phone sheet): the last scrollTop is restored on the first layout after re-showing.
 */
function useKeptScroll(box: { current: HTMLDivElement | null }, hidden: boolean, follow: boolean) {
  const kept = useRef(0);
  useLayoutEffect(() => {
    const node = box.current;
    if (node === null || hidden) return;
    if (!follow && kept.current > 0) node.scrollTop = kept.current;
  }, [box, hidden, follow]);
  return (top: number) => {
    kept.current = top;
  };
}

type Anchor = { readonly id: string; readonly top: number };

/** The first item the member can see in the scroller, with its on-screen position. */
function topVisible(box: HTMLElement): Anchor | null {
  const frame = box.getBoundingClientRect().top;
  for (const item of box.querySelectorAll<HTMLElement>('li[id]')) {
    const r = item.getBoundingClientRect();
    if (r.height > 0 && r.bottom > frame) return { id: item.id, top: r.top };
  }
  return null;
}

/** Scrolls so the anchored item is back where it was, wherever new content was inserted. */
function holdAnchor(box: HTMLElement, anchor: Anchor): void {
  const item = document.getElementById(anchor.id);
  if (item !== null) box.scrollTop += item.getBoundingClientRect().top - anchor.top;
}

/** Nothing to list yet: no teammate chosen, or the deep-linked teammate is gone. */
function emptyState(state: WorkspaceState): JSX.Element | null {
  if (state.route.teammate === null)
    return (
      <Empty
        text={
          state.notice?.code === 'no_teammates'
            ? 'Add a teammate to start.'
            : 'Pick a teammate from the sidebar.'
        }
      />
    );
  if (state.route.panel.kind === 'missing' && state.route.panel.what === 'teammate')
    return (
      <Empty
        alert
        text="This teammate is not available to you anymore. Pick another one from the sidebar."
      />
    );
  return null;
}

function Footer(props: {
  readonly conversation: ConversationState;
  readonly offline: boolean;
  readonly onJump: () => void;
}): JSX.Element {
  const { conversation } = props;
  return (
    <>
      {conversation.unseen > 0 && !conversation.follow ? (
        <button type="button" class="btn btn-primary tl-new" onClick={props.onJump}>
          New activity ({conversation.unseen})
        </button>
      ) : null}
      {props.offline ? (
        <p class="tl-net" role="status">
          Connection trouble. Retrying…
        </p>
      ) : null}
    </>
  );
}

export function Timeline(): JSX.Element {
  const { store, effects } = useWorkspace();
  const state = store.state.value;
  const conversation = state.conversation;
  const teammate = activeTeammate(state);
  const box = useRef<HTMLDivElement>(null);
  const [earlier, setEarlier] = useState(false);
  const count = conversation?.messages.length ?? 0;
  const tasksHeld = Object.keys(state.tasks).length;
  const follow = conversation?.follow ?? true;
  const hidden = panelOpen(state) && (state.review.expanded || state.layout !== 'desktop');
  const keep = useKeptScroll(box, hidden, follow);
  // Where the timeline last pinned itself. Content that grows below a pin fires scroll events
  // without the member moving; only a position above the pin is the member reading upwards.
  const pinnedTop = useRef(0);
  const pin = (node: HTMLDivElement) => {
    node.scrollTop = node.scrollHeight;
    pinnedTop.current = node.scrollTop;
  };
  const showEarlier = async (node: HTMLDivElement) => {
    // Older messages can land anywhere above the reading position (contributions of old tasks
    // sort before them), so hold the item the member is looking at.
    const anchor = topVisible(node);
    // Paging back means reading history, so new activity must not pull the view down.
    store.dispatch({ type: 'conversation/follow', follow: false });
    setEarlier(true);
    try {
      await effects.loadEarlier();
      await new Promise(requestAnimationFrame);
      if (anchor !== null) holdAnchor(node, anchor);
    } finally {
      setEarlier(false);
    }
  };
  useLayoutEffect(() => {
    const node = box.current;
    if (node !== null && follow && !hidden) pin(node);
  }, [count, tasksHeld, follow, hidden, conversation?.id, conversation?.reply]);
  // Cards and Markdown settle after the first paint; while following, growth keeps the bottom.
  useEffect(() => {
    const node = box.current;
    const list = node?.querySelector('.tl-list') ?? null;
    if (node === null || list === null || !follow || hidden) return;
    const observer = new ResizeObserver(() => pin(node));
    observer.observe(list);
    // The scroller itself shrinks when the composer grows (chips, target row, errors).
    observer.observe(node);
    return () => observer.disconnect();
  }, [follow, hidden, conversation?.id]);
  const empty = emptyState(state);
  if (empty !== null || conversation === null)
    return empty ?? <Empty text="Loading the conversation…" />;
  const now = new Date();
  const items = timelineOf(state, now);
  const name = teammate?.name ?? 'your teammate';
  const jumpToLatest = () => {
    store.dispatch({ type: 'conversation/seen' });
    const node = box.current;
    if (node !== null) pin(node);
  };
  return (
    <div class="tl-wrap">
      <div
        class="tl"
        ref={box}
        onScroll={(event) => {
          keep(event.currentTarget.scrollTop);
          const near = nearBottom(event.currentTarget);
          const reading = event.currentTarget.scrollTop < pinnedTop.current - 4;
          if (!near && !reading) return;
          if (near !== conversation.follow)
            store.dispatch({ type: 'conversation/follow', follow: near });
        }}
      >
        <h2 class="visually-hidden">Conversation with {name}</h2>
        {conversation.prevCursor === null ? null : (
          <button
            type="button"
            class="btn tl-earlier"
            disabled={earlier}
            aria-busy={earlier}
            onClick={() => {
              if (box.current !== null) void showEarlier(box.current);
            }}
          >
            {earlier ? 'Loading earlier messages…' : 'Show earlier messages'}
          </button>
        )}
        {items.length === 0 ? (
          <p class="tl-hint">No messages yet. Ask {name} how they would approach something.</p>
        ) : null}
        <ol
          class="tl-list"
          aria-label="Conversation"
          aria-live="polite"
          aria-relevant="additions"
          aria-busy={!timelineSettled(state)}
        >
          {items.map((item) => (
            <Item key={item.id} item={item} state={state} now={now} />
          ))}
          <TaskDraftCard />
        </ol>
        <ReplyStatus conversation={conversation} name={name} />
      </div>
      <Footer conversation={conversation} offline={state.net.offline} onJump={jumpToLatest} />
    </div>
  );
}
