import { useLayoutEffect, useRef } from 'preact/hooks';

import { pages } from '../../../shared/contract.js';
import { nearBottom } from '../store/anchoring.js';
import { activeTeammate } from '../store/selectors.js';
import { clockTime } from '../store/time.js';
import { timelineItems } from '../store/timeline-items.js';

import { Avatar, initialsOf } from './avatars.jsx';
import { useWorkspace } from './context.js';

import type { TeammateRow } from '../../../shared/contract.js';
import type { ConversationState } from '../store/state.js';
import type { MessageView } from '@agent-works/domain/teamwork';
import type { JSX } from 'preact';

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

function BubbleAvatar(props: {
  readonly mine: boolean;
  readonly teammate: TeammateRow | undefined;
  readonly memberName: string;
  readonly name: string;
}): JSX.Element {
  if (props.mine) return <Initials name={props.memberName} member />;
  if (props.teammate === undefined) return <Initials name={props.name} member={false} />;
  const { appearance, id, name } = props.teammate;
  return <Avatar appearance={appearance} id={id} name={name} size={32} />;
}

function Bubble(props: {
  readonly message: MessageView;
  readonly grouped: boolean;
  readonly teammate: TeammateRow | undefined;
  readonly memberName: string;
  readonly segment: string;
}): JSX.Element {
  const { message, grouped, teammate, segment } = props;
  if (message.role === 'system')
    return (
      <li class="sys" id={`msg:${message.id}`}>
        <span>{message.text}</span>
        <time dateTime={message.at}>{clockTime(message.at)}</time>
      </li>
    );
  const mine = message.role === 'member';
  const name = mine ? 'You' : (teammate?.name ?? 'Teammate');
  const stamp = <time dateTime={message.at}>{clockTime(message.at)}</time>;
  return (
    <li
      class={`msg ${mine ? 'msg-member' : 'msg-teammate'}${grouped ? ' msg-grouped' : ''}`}
      id={`msg:${message.id}`}
    >
      <span class="msg-avatar">
        {grouped ? null : (
          <BubbleAvatar mine={mine} teammate={teammate} memberName={props.memberName} name={name} />
        )}
      </span>
      <div class="msg-body">
        {grouped ? null : (
          <span class="msg-meta">
            <span class="msg-author">{name}</span>
            {stamp}
          </span>
        )}
        <div class="bubble">
          <p class="msg-text">{message.text}</p>
          {message.card === null ? null : (
            <a class="card-link" href={pages.task(segment, message.card.taskId)}>
              Open task: {message.card.title}
            </a>
          )}
          {grouped ? <span class="msg-stamp">{stamp}</span> : null}
        </div>
      </div>
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

export function Timeline(): JSX.Element {
  const { store } = useWorkspace();
  const state = store.state.value;
  const conversation = state.conversation;
  const teammate = activeTeammate(state);
  const box = useRef<HTMLDivElement>(null);
  const count = conversation?.messages.length ?? 0;
  const follow = conversation?.follow ?? true;
  useLayoutEffect(() => {
    const node = box.current;
    if (node !== null && follow) node.scrollTop = node.scrollHeight;
  }, [count, follow, conversation?.id, conversation?.reply]);
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
  if (state.route.panel.kind === 'missing')
    return (
      <Empty
        alert
        text="This teammate is not available to you anymore. Pick another one from the sidebar."
      />
    );
  if (conversation === null) return <Empty text="Loading the conversation…" />;
  const items = timelineItems(conversation.messages, new Date());
  const name = teammate?.name ?? 'your teammate';
  const jumpToLatest = () => {
    store.dispatch({ type: 'conversation/seen' });
    const node = box.current;
    if (node !== null) node.scrollTop = node.scrollHeight;
  };
  return (
    <div class="tl-wrap">
      <div
        class="tl"
        ref={box}
        onScroll={(event) => {
          const near = nearBottom(event.currentTarget);
          if (near !== conversation.follow)
            store.dispatch({ type: 'conversation/follow', follow: near });
        }}
      >
        {items.length === 0 ? (
          <p class="tl-hint">No messages yet. Ask {name} how they would approach something.</p>
        ) : null}
        <ol class="tl-list" aria-label="Conversation" aria-live="polite" aria-relevant="additions">
          {items.map((item) =>
            item.kind === 'day' ? (
              <li key={item.id} class="day" role="separator" aria-label={item.label}>
                <span>{item.label}</span>
              </li>
            ) : (
              <Bubble
                key={item.id}
                message={item.message}
                grouped={item.grouped}
                teammate={teammate}
                memberName={state.me.member.name}
                segment={state.scope.segment}
              />
            ),
          )}
        </ol>
        <ReplyStatus conversation={conversation} name={name} />
      </div>
      {conversation.unseen > 0 && !conversation.follow ? (
        <button type="button" class="btn btn-primary tl-new" onClick={jumpToLatest}>
          New activity ({conversation.unseen})
        </button>
      ) : null}
      {state.net.offline ? (
        <p class="tl-net" role="status">
          Connection trouble. Retrying…
        </p>
      ) : null}
    </div>
  );
}
