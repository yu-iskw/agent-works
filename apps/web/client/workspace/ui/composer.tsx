import { useEffect, useRef, useState } from 'preact/hooks';

import { pages } from '../../../shared/contract.js';
import { enterAction } from '../store/composer-keys.js';
import { activeDraft, activeTeammate } from '../store/selectors.js';

import { useWorkspace } from './context.js';

import type { JSX } from 'preact';

const MAX_ROWS = 8;

function PlusMenu(props: {
  readonly segment: string;
  readonly conversationId: string;
  readonly onClose: () => void;
}): JSX.Element {
  const first = useRef<HTMLAnchorElement>(null);
  useEffect(() => first.current?.focus(), []);
  return (
    <div
      class="menu"
      role="menu"
      aria-label="Add to the message"
      onKeyDown={(event) => {
        if (event.key === 'Escape') {
          event.preventDefault();
          props.onClose();
        }
      }}
    >
      <a
        ref={first}
        role="menuitem"
        class="menu-item"
        href={pages.newTask(props.segment, props.conversationId)}
      >
        Start a task
        <span class="menu-hint">Opens the task page with this conversation linked</span>
      </a>
      <span role="menuitem" aria-disabled="true" class="menu-item menu-item-off">
        Attach a file
        <span class="menu-hint">Coming next</span>
      </span>
    </div>
  );
}

export function Composer(): JSX.Element | null {
  const { store, effects } = useWorkspace();
  const state = store.state.value;
  const conversation = state.conversation;
  const draft = activeDraft(state);
  const teammate = activeTeammate(state);
  const [menu, setMenu] = useState(false);
  const [composing, setComposing] = useState(false);
  const area = useRef<HTMLTextAreaElement>(null);
  const plus = useRef<HTMLButtonElement>(null);
  const sendKey = state.prefs.sendKey;
  const sending = state.composer.sending !== null;
  const canSend =
    conversation !== null && !sending && draft.text.trim() !== '' && !state.me.readOnly;

  useEffect(() => {
    const node = area.current;
    if (node === null) return;
    node.style.height = 'auto';
    const line = Number.parseFloat(getComputedStyle(node).lineHeight) || 22;
    node.style.height = `${Math.min(node.scrollHeight, line * MAX_ROWS + 20)}px`;
  }, [draft.text]);

  if (conversation === null || state.route.panel.kind === 'missing') return null;
  const closeMenu = () => {
    setMenu(false);
    plus.current?.focus();
  };
  const name = teammate?.name ?? 'your teammate';
  return (
    <form
      class="cp"
      onSubmit={(event) => {
        event.preventDefault();
        if (canSend) void effects.send();
      }}
    >
      <div class="cp-row">
        <div class="cp-plus">
          <button
            ref={plus}
            type="button"
            class="btn btn-icon"
            aria-label="Add to the message"
            aria-haspopup="menu"
            aria-expanded={menu}
            onClick={() => setMenu((open) => !open)}
          >
            <span aria-hidden="true">+</span>
          </button>
          {menu ? (
            <PlusMenu
              segment={state.scope.segment}
              conversationId={conversation.id}
              onClose={closeMenu}
            />
          ) : null}
        </div>
        <textarea
          ref={area}
          class="cp-text"
          aria-label="Message"
          placeholder={`Message ${name}`}
          rows={1}
          value={draft.text}
          disabled={state.me.readOnly}
          onInput={(event) => effects.setDraft(event.currentTarget.value)}
          onCompositionStart={() => setComposing(true)}
          onCompositionEnd={() => setComposing(false)}
          onKeyDown={(event) => {
            const action = enterAction(
              {
                enter: event.key === 'Enter',
                shift: event.shiftKey,
                mod: event.ctrlKey || event.metaKey,
                composing: composing || event.isComposing || event.keyCode === 229,
              },
              sendKey,
            );
            if (action === 'send') {
              event.preventDefault();
              if (canSend) void effects.send();
            }
          }}
        />
        <button
          type="submit"
          class="btn btn-primary btn-icon cp-send"
          aria-label="Send"
          disabled={!canSend}
          aria-busy={sending}
        >
          <span aria-hidden="true">➤</span>
        </button>
      </div>
      <div class="cp-foot">
        {state.composer.error === null ? (
          <span class="cp-hint">
            {sendKey === 'enter'
              ? 'Enter to send · Shift+Enter for a new line'
              : 'Ctrl/Cmd+Enter to send · Enter for a new line'}
          </span>
        ) : (
          <span class="cp-error" role="alert">
            {state.composer.error}
          </span>
        )}
        {state.me.readOnly ? <span class="cp-hint">Read-only in this segment</span> : null}
      </div>
    </form>
  );
}
