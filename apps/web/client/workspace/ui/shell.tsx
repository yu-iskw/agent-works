import { useEffect, useRef, useState } from 'preact/hooks';

import { panelExpanded } from '../store/review-state.js';
import { activeTeammate, panelOpen } from '../store/selectors.js';

import { Composer } from './composer.jsx';
import { useWorkspace } from './context.js';
import { Header } from './header.jsx';
import { Panel } from './panel.jsx';
import { Sidebar } from './sidebar.jsx';
import { Timeline } from './timeline.jsx';

import type { JSX } from 'preact';

const NOTICE_TEXT = {
  remembered_teammate_gone:
    'The teammate you last talked to is no longer available, so this one opened instead.',
  no_teammates: 'There are no teammates in this segment yet.',
  segment_unavailable: 'The segment did not answer. What you see may be out of date.',
} as const;

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex="0"]';

/**
 * On a phone the sidebar is an off-canvas sheet: a modal dialog with a focus trap, Escape and the
 * scrim to close, and focus returned to the menu button. Elsewhere it is a static column. The
 * sheet is open only while the layout is the phone one, so a request made before a resize can
 * never leave it open on another layout, and the attribute the page paints follows the same rule.
 */
function useSheet(layout: string): {
  readonly open: boolean;
  readonly show: () => void;
  readonly hide: () => void;
  readonly aside: { current: HTMLDivElement | null };
} {
  const [requested, setRequested] = useState(false);
  const aside = useRef<HTMLDivElement | null>(null);
  const opener = useRef<HTMLElement | null>(null);
  const phone = layout === 'phone';
  const open = phone && requested;
  useEffect(() => {
    if (!phone) setRequested(false);
  }, [phone]);
  useEffect(() => {
    if (!open) return;
    const node = aside.current;
    opener.current = document.activeElement as HTMLElement | null;
    node?.querySelector<HTMLElement>(FOCUSABLE)?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        setRequested(false);
        return;
      }
      if (event.key !== 'Tab' || node === null) return;
      const items = [...node.querySelectorAll<HTMLElement>(FOCUSABLE)];
      const first = items.at(0);
      const last = items.at(-1);
      if (first === undefined || last === undefined) return;
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('keydown', onKey);
      opener.current?.focus();
    };
  }, [open]);
  return {
    open,
    show: () => {
      if (phone) setRequested(true);
    },
    hide: () => setRequested(false),
    aside,
  };
}

function Notice(): JSX.Element | null {
  const { store } = useWorkspace();
  const notice = store.notice.value;
  if (notice === null) return null;
  return (
    <div class="notice" role="status">
      <span>
        {notice.code === 'segment_unavailable'
          ? `${NOTICE_TEXT[notice.code]} (${notice.error})`
          : NOTICE_TEXT[notice.code]}
      </span>
      <button
        type="button"
        class="btn btn-quiet btn-sm"
        onClick={() => store.dispatch({ type: 'notice/dismiss' })}
      >
        Dismiss
      </button>
    </div>
  );
}

type SheetAttributes = Pick<JSX.HTMLAttributes<HTMLElement>, 'role' | 'aria-modal' | 'inert'>;

/**
 * A `div` so the role can change with the layout: a modal dialog while the sidebar is a sheet (a
 * closed sheet is inert to focus), the complementary landmark everywhere else.
 */
const sheetAttributes = (phone: boolean, open: boolean): SheetAttributes =>
  phone ? { role: 'dialog', 'aria-modal': open, inert: !open } : { role: 'complementary' };

export function Shell(): JSX.Element {
  const { store } = useWorkspace();
  const state = store.state.value;
  const open = panelOpen(state);
  const phone = state.layout === 'phone';
  const sheet = useSheet(state.layout);
  // Below the desktop width, or expanded, the panel replaces the conversation. It then renders
  // inside the main landmark with its own level-one heading, so the page keeps both.
  const panelOnMain = open && (state.layout !== 'desktop' || panelExpanded(state));
  const context = activeTeammate(state)?.name ?? state.me.segmentName;
  return (
    <div
      class="ws"
      data-layout={state.layout}
      data-panel={open ? 'open' : 'closed'}
      data-sheet={sheet.open ? 'open' : 'closed'}
      data-expanded={String(panelExpanded(state))}
      style={{ '--panel-w': `${state.panel.width}px` }}
    >
      {sheet.open ? (
        <button
          type="button"
          class="sheet-scrim"
          aria-label="Close the sidebar"
          onClick={sheet.hide}
        />
      ) : null}
      <div
        class="ws-side"
        id="sidebar"
        aria-label="Sidebar"
        ref={sheet.aside}
        {...sheetAttributes(phone, sheet.open)}
      >
        <Sidebar onPick={sheet.hide} sheet={phone} />
      </div>
      <main class="ws-main" data-showing={panelOnMain ? 'panel' : 'conversation'}>
        <Header onMenu={sheet.show} menuOpen={sheet.open} />
        <Notice />
        <Timeline />
        <Composer />
        {panelOnMain ? (
          <div class="ws-panel">
            <h1 class="visually-hidden">{context}</h1>
            <Panel />
          </div>
        ) : null}
      </main>
      {open && !panelOnMain ? (
        <aside class="ws-panel">
          <Panel />
        </aside>
      ) : null}
    </div>
  );
}
