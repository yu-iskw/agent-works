import { useEffect, useState } from 'preact/hooks';

import { panelOpen } from '../store/selectors.js';

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

export function Shell(): JSX.Element {
  const { store } = useWorkspace();
  const state = store.state.value;
  const open = panelOpen(state);
  const [sheet, setSheet] = useState(false);
  useEffect(() => {
    if (state.layout !== 'phone') setSheet(false);
  }, [state.layout]);
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && sheet) setSheet(false);
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [sheet]);
  const notice = state.notice;
  return (
    <div
      class="ws"
      data-layout={state.layout}
      data-panel={open ? 'open' : 'closed'}
      data-sheet={sheet ? 'open' : 'closed'}
    >
      {sheet ? (
        <button
          type="button"
          class="sheet-scrim"
          aria-label="Close the sidebar"
          onClick={() => setSheet(false)}
        />
      ) : null}
      <aside class="ws-side" id="sidebar" aria-label="Sidebar">
        <Sidebar onPick={() => setSheet(false)} />
      </aside>
      <main class="ws-main">
        <Header onMenu={() => setSheet(true)} />
        {notice === null ? null : (
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
        )}
        <Timeline />
        <Composer />
      </main>
      {open ? (
        <aside class="ws-panel" style={{ '--panel-w': `${state.panel.width}px` }}>
          <Panel />
        </aside>
      ) : null}
    </div>
  );
}
