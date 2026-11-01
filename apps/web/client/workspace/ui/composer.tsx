// The composer: an expanding textarea with + / @ / menus, context chips, the send target and
// error reporting. Routing lives in the store, the menu model in composer/use-menu.ts; this file
// owns focus, caret and the keyboard.

import { useEffect, useMemo, useRef, useState } from 'preact/hooks';

import { FILE_ACCEPT, isWorkChip } from '../../../shared/composer.js';
import { CLARIFY_TEXT } from '../store/composer-effects.js';
import { enterAction } from '../store/composer-keys.js';
import { EMPTY_TEXT } from '../store/composer-menu.js';
import { targetCandidates } from '../store/composer-routing.js';
import { activeDraft, activeTeammate } from '../store/selectors.js';

import { ChipRow } from './composer/chips.jsx';
import { ComposerFoot } from './composer/foot.jsx';
import { MenuList } from './composer/menu.jsx';
import { TargetChip } from './composer/target-chip.jsx';
import { useComposerMenu } from './composer/use-menu.js';
import { useWorkspace } from './context.js';

import type { MenuModel } from './composer/use-menu.js';
import type { SendKey } from '../../../shared/contract.js';
import type { Draft, WorkspaceState } from '../store/state.js';
import type { JSX, RefObject } from 'preact';

const MAX_ROWS = 8;
const LIST_ID = 'cp-menu';

type Facts = {
  readonly sending: boolean;
  readonly uploading: boolean;
  readonly hasWork: boolean;
  readonly canSend: boolean;
};

function composerFacts(state: WorkspaceState, draft: Draft): Facts {
  const sending = state.composer.sending !== null;
  const uploading = draft.chips.some((c) => c.kind === 'file' && c.status === 'uploading');
  const hasWork = draft.chips.some(isWorkChip);
  const blocked = sending || uploading || state.me.readOnly || state.conversation === null;
  return {
    sending,
    uploading,
    hasWork,
    canSend: !blocked && (draft.text.trim() !== '' || hasWork),
  };
}

/** Backspace with the caret at the very start moves focus to the last chip's remove button. */
function backspaceToChips(event: KeyboardEvent, node: HTMLTextAreaElement, chips: number): boolean {
  if (event.key !== 'Backspace' || chips === 0) return false;
  if (node.selectionStart !== 0 || node.selectionEnd !== 0) return false;
  event.preventDefault();
  const buttons = node.parentElement?.querySelectorAll<HTMLButtonElement>('.cx-x');
  buttons?.[buttons.length - 1]?.focus();
  return true;
}

function Menus(props: { readonly model: MenuModel }): JSX.Element | null {
  const { model } = props;
  if (model.menu === null) return null;
  if (model.menu.kind === 'plus')
    return (
      <MenuList
        id={LIST_ID}
        label="Add to the message"
        groups={model.groups}
        active={model.active}
        emptyText={EMPTY_TEXT.plus}
        onPick={model.pick}
        onHover={model.setActive}
        focusable={{
          ref: (node) => node?.focus(),
          onKeyDown: (event) => {
            model.onKey(event);
          },
        }}
      />
    );
  const mention = model.menu.kind === 'mention';
  return (
    <MenuList
      id={LIST_ID}
      label={mention ? 'Teammates and sources' : 'Skills and commands'}
      groups={model.groups}
      active={model.active}
      emptyText={mention ? EMPTY_TEXT.mention : EMPTY_TEXT.command}
      onPick={model.pick}
      onHover={model.setActive}
    />
  );
}

function MessageArea(props: {
  readonly areaRef: RefObject<HTMLTextAreaElement>;
  readonly draft: Draft;
  readonly name: string;
  readonly readOnly: boolean;
  readonly sendKey: SendKey;
  readonly model: MenuModel;
  readonly canSend: boolean;
  readonly onSubmit: () => void;
  readonly onFocusTextarea: () => void;
}): JSX.Element {
  const { effects } = useWorkspace();
  // A ref, not state: the keydown that follows compositionstart must see it before any re-render.
  const composing = useRef(false);
  const { model, draft } = props;
  // Native listeners: textareas expose no `oncompositionstart` property, so a Preact
  // `onCompositionStart` prop registers a `CompositionStart` listener that never fires.
  useEffect(() => {
    const node = props.areaRef.current;
    if (node === null) return;
    const start = () => {
      composing.current = true;
    };
    const end = () => {
      composing.current = false;
    };
    node.addEventListener('compositionstart', start);
    node.addEventListener('compositionend', end);
    return () => {
      node.removeEventListener('compositionstart', start);
      node.removeEventListener('compositionend', end);
    };
  }, [props.areaRef]);
  const triggerOpen = model.menu !== null && model.menu.kind !== 'plus';
  const syncFrom = (node: HTMLTextAreaElement) => model.sync(node.value, node.selectionStart);
  const onKeyDown = (event: KeyboardEvent) => {
    const node = event.currentTarget as HTMLTextAreaElement;
    const isComposing = composing.current || event.isComposing || event.keyCode === 229;
    if (triggerOpen && !isComposing && model.onKey(event)) return;
    if (backspaceToChips(event, node, draft.chips.length)) return;
    const facts = {
      enter: event.key === 'Enter',
      shift: event.shiftKey,
      mod: event.ctrlKey || event.metaKey,
      composing: isComposing,
    };
    if (enterAction(facts, props.sendKey) === 'send') {
      event.preventDefault();
      if (props.canSend) props.onSubmit();
    }
  };
  return (
    <div class="cp-main">
      <ChipRow chips={draft.chips} onFocusTextarea={props.onFocusTextarea} />
      <textarea
        ref={props.areaRef}
        class="cp-text"
        aria-label="Message"
        placeholder={`Message ${props.name}`}
        rows={1}
        value={draft.text}
        disabled={props.readOnly}
        aria-controls={triggerOpen ? LIST_ID : undefined}
        aria-activedescendant={
          triggerOpen && model.activeItem !== null ? `${LIST_ID}-${model.activeItem.id}` : undefined
        }
        onInput={(event) => {
          effects.setDraft(event.currentTarget.value);
          syncFrom(event.currentTarget);
        }}
        onClick={(event) => syncFrom(event.currentTarget)}
        onKeyUp={(event) => {
          if (event.key === 'ArrowLeft' || event.key === 'ArrowRight')
            syncFrom(event.currentTarget);
        }}
        onKeyDown={onKeyDown}
      />
    </div>
  );
}

export function Composer(): JSX.Element | null {
  const { store, effects } = useWorkspace();
  const state = store.state.value;
  const conversation = state.conversation;
  const draft = activeDraft(state);
  const teammate = activeTeammate(state);
  const [clarify, setClarify] = useState(false);
  const area = useRef<HTMLTextAreaElement>(null);
  const plus = useRef<HTMLButtonElement>(null);
  const picker = useRef<HTMLInputElement>(null);
  const pendingCaret = useRef<number | null>(null);
  const facts = composerFacts(state, draft);
  const candidates = useMemo(
    () => targetCandidates(state.composer.targets),
    [state.composer.targets],
  );

  const focusArea = (caret?: number) => {
    const node = area.current;
    if (node === null) return;
    node.focus();
    if (caret !== undefined) node.setSelectionRange(caret, caret);
  };

  const model = useComposerMenu({
    state,
    effects,
    text: draft.text,
    candidates,
    openFilePicker: () => picker.current?.click(),
    focusArea,
    focusPlus: () => plus.current?.focus(),
    setCaret: (caret) => {
      pendingCaret.current = caret;
    },
    askTarget: () => setClarify(true),
  });

  useEffect(() => {
    const node = area.current;
    if (node === null) return;
    node.style.height = 'auto';
    const line = Number.parseFloat(getComputedStyle(node).lineHeight) || 22;
    node.style.height = `${Math.min(node.scrollHeight, line * MAX_ROWS + 20)}px`;
    if (pendingCaret.current !== null) {
      node.setSelectionRange(pendingCaret.current, pendingCaret.current);
      pendingCaret.current = null;
    }
  }, [draft.text]);

  useEffect(() => {
    if (conversation !== null) void effects.ensureContext();
  }, [conversation, effects]);

  useEffect(() => {
    setClarify(false);
  }, [draft.target, conversation?.id]);

  if (conversation === null || state.route.panel.kind === 'missing') return null;
  const name = teammate?.name ?? 'your teammate';
  const plusOpen = model.menu?.kind === 'plus';

  const submit = () => {
    setClarify(false);
    void effects.submit().then(() => {
      if (store.peek().composer.error === CLARIFY_TEXT) setClarify(true);
    });
  };

  return (
    <form
      class="cp"
      aria-busy={facts.sending || facts.uploading || state.composer.starting}
      onSubmit={(event) => {
        event.preventDefault();
        if (facts.canSend) submit();
      }}
    >
      <input
        ref={picker}
        type="file"
        accept={FILE_ACCEPT}
        multiple
        class="visually-hidden"
        tabIndex={-1}
        aria-hidden="true"
        onChange={(event) => {
          const files = [...(event.currentTarget.files ?? [])];
          event.currentTarget.value = '';
          effects.attachFiles(files);
          focusArea();
        }}
      />
      <div inert={model.menu !== null}>
        <TargetChip
          candidates={candidates}
          chosen={draft.target}
          teammateName={name}
          clarify={clarify}
          onPicked={() => {
            setClarify(false);
            focusArea();
          }}
        />
      </div>
      <div class="cp-row">
        <div class="cp-plus">
          <button
            ref={plus}
            type="button"
            class="btn btn-icon"
            aria-label="Add to the message"
            aria-haspopup="listbox"
            aria-expanded={plusOpen}
            aria-controls={plusOpen ? LIST_ID : undefined}
            onClick={() => (plusOpen ? model.close() : model.openPlus())}
          >
            <span aria-hidden="true">+</span>
          </button>
          <Menus model={model} />
        </div>
        <MessageArea
          areaRef={area}
          draft={draft}
          name={name}
          readOnly={state.me.readOnly}
          sendKey={state.prefs.sendKey}
          model={model}
          canSend={facts.canSend}
          onSubmit={submit}
          onFocusTextarea={() => focusArea()}
        />
        <button
          type="submit"
          class="btn btn-primary btn-icon cp-send"
          aria-label={facts.hasWork ? 'Create task' : 'Send'}
          disabled={!facts.canSend}
          aria-busy={facts.sending}
        >
          <span aria-hidden="true">➤</span>
        </button>
      </div>
      <ComposerFoot
        error={state.composer.taskDraft === null ? state.composer.error : null}
        hasWork={facts.hasWork}
        uploading={facts.uploading}
        readOnly={state.me.readOnly}
        sendKey={state.prefs.sendKey}
      />
    </form>
  );
}
