// The adaptive panel's frame: heading focus, Back, Expand and Restore, Close, Escape, focus
// return, and the remembered reading position per view. Each panel kind draws its own body.

import { useEffect, useLayoutEffect, useRef } from 'preact/hooks';

import { PANEL_TITLES, positionKey } from '../store/panel-routes.js';

import { useWorkspace } from './context.js';
import { TeammatePanel } from './identity/teammate-panel.jsx';
import { InboxPanel } from './inbox/inbox-panel.jsx';
import { RecapPanel } from './inbox/recap-panel.jsx';
import { ApprovalPanel } from './panel/approval-panel.jsx';
import { restoreInvoker } from './panel/invoker.js';
import { PlanPanel } from './panel/plan-panel.jsx';
import { ResultPanel } from './panel/result-panel.jsx';
import { PanelSeparator } from './panel/separator.jsx';
import { TaskPanel } from './panel/task-panel.jsx';
import { PreferencesPanel } from './preferences/preferences-panel.jsx';

import type { PanelRoute } from '../../../shared/route.js';
import type { JSX } from 'preact';

/** Which panel kinds have a body; the rest show the placeholder until their unit lands. */
function Body(props: { readonly panel: PanelRoute }): JSX.Element {
  const { panel } = props;
  switch (panel.kind) {
    case 'result':
      return <ResultPanel panel={panel} />;
    case 'plan':
      return <PlanPanel panel={panel} />;
    case 'approval':
      return <ApprovalPanel panel={panel} />;
    case 'task':
      return <TaskPanel panel={panel} />;
    case 'teammate':
      return <TeammatePanel />;
    case 'inbox':
      return <InboxPanel />;
    case 'recap':
      return <RecapPanel />;
    case 'preferences':
      return <PreferencesPanel />;
    case 'missing':
      return (
        <p role="alert">
          This {panel.what} is not available to you anymore. It may have been removed or belong to
          another member.
        </p>
      );
    case 'none':
    case 'draft':
      return <p>This view is not built yet.</p>;
  }
}

/** The heading takes focus when a panel opens or changes subject, not on view changes within it. */
const focusKey = (panel: PanelRoute): string =>
  panel.kind === 'result' ? `${panel.kind}:${panel.taskId}` : JSON.stringify(panel);

export function Panel(): JSX.Element {
  const { store, effects } = useWorkspace();
  const state = store.state.value;
  const panel = state.route.panel;
  const title = PANEL_TITLES[panel.kind];
  const heading = useRef<HTMLHeadingElement>(null);
  const body = useRef<HTMLDivElement>(null);
  const key = positionKey(panel);
  const expanded = state.review.expanded;
  const desktop = state.layout === 'desktop';
  const subject = focusKey(panel);

  useEffect(() => {
    const cited = panel.kind === 'result' && panel.citation !== null;
    if (!cited) heading.current?.focus({ preventScroll: true });
  }, [subject]);

  useEffect(() => restoreInvoker, []);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented) return;
      const target = event.target;
      if (target instanceof HTMLElement && target.closest('[role="menu"], dialog') !== null) return;
      event.preventDefault();
      effects.back();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [effects]);

  useLayoutEffect(() => {
    const node = body.current;
    if (node === null || key === null) return;
    // Position keys are built from segment ids and read from a plain record.
    // eslint-disable-next-line security/detect-object-injection
    node.scrollTop = state.review.positions[key] ?? 0;
  }, [key]);

  const remember = (top: number) => {
    if (key !== null) effects.panel.remember(key, top);
  };

  return (
    <section class="pn" aria-labelledby="pn-title" data-expanded={expanded ? 'true' : 'false'}>
      {desktop && !expanded ? <PanelSeparator /> : null}
      <div class="pn-head">
        <button type="button" class="btn btn-quiet pn-back" onClick={() => effects.back()}>
          <span aria-hidden="true">← </span>Back to conversation
        </button>
        <h2 id="pn-title" ref={heading} tabIndex={-1}>
          {title}
        </h2>
        {desktop ? (
          <button
            type="button"
            class="btn btn-icon pn-expand"
            aria-label={expanded ? 'Restore the split view' : 'Expand the panel'}
            aria-pressed={expanded}
            onClick={() => effects.panel.expand(!expanded)}
          >
            <span aria-hidden="true">{expanded ? '⇲' : '⇱'}</span>
          </button>
        ) : null}
        <button
          type="button"
          class="btn btn-icon pn-close"
          aria-label="Close panel"
          onClick={() => effects.back()}
        >
          <span aria-hidden="true">×</span>
        </button>
      </div>
      <div class="pn-body" ref={body} onScroll={(event) => remember(event.currentTarget.scrollTop)}>
        <Body panel={panel} />
      </div>
    </section>
  );
}
