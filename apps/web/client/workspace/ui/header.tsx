// The header is one wrapping flex row: identity left (truncates), controls right (never shrink),
// and the simulation line, which sits inline when the column is wide and drops under the title
// when it is not. The column width, not the viewport, decides, so an open panel behaves like a
// narrow screen.

import { closePanel } from '../store/effects.js';
import { activeTeammate, panelOpen } from '../store/selectors.js';

import { Avatar } from './avatars.jsx';
import { useWorkspace } from './context.js';

import type { JSX } from 'preact';

export function Header(props: {
  readonly onMenu: () => void;
  readonly menuOpen: boolean;
}): JSX.Element {
  const { store, effects } = useWorkspace();
  const state = store.state.value;
  const me = state.me;
  const teammate = activeTeammate(state);
  const route = state.route;
  const details = route.panel.kind === 'teammate';
  const toggleDetails = () => {
    if (route.teammate === null) return;
    effects.open(details ? closePanel(route) : { ...route, panel: { kind: 'teammate' } });
  };
  const sources = me.sourceMode === 'fixture' ? 'Demo sources' : 'Live sources';
  const model = me.model.mode === 'stub' ? 'Scripted model' : 'Gemini';
  return (
    <header class="hd" data-panel={panelOpen(state) ? 'open' : 'closed'}>
      <button
        type="button"
        class="btn btn-icon hd-menu"
        aria-label="Open the sidebar"
        aria-expanded={props.menuOpen}
        aria-controls="sidebar"
        onClick={props.onMenu}
      >
        <span aria-hidden="true">≡</span>
      </button>
      {teammate === undefined ? (
        <div class="hd-who">
          <div class="hd-text">
            <h1 class="hd-name">{me.segmentName}</h1>
            <p class="hd-role">Choose a teammate to start a conversation.</p>
          </div>
        </div>
      ) : (
        <div class="hd-who">
          <Avatar
            appearance={teammate.appearance}
            id={teammate.id}
            name={teammate.name}
            size={40}
          />
          <div class="hd-text">
            <h1 class="hd-name">
              <span class="hd-name-text">{teammate.name}</span>
              {teammate.working ? <span class="hd-state">Working</span> : null}
            </h1>
            <p class="hd-role">{teammate.role}</p>
          </div>
        </div>
      )}
      <div class="hd-right">
        {teammate === undefined ? null : (
          <button
            type="button"
            class="btn btn-quiet btn-sm hd-details"
            aria-pressed={details}
            onClick={toggleDetails}
          >
            Details
          </button>
        )}
        <span class="hd-seg" title={`Segment: ${me.segmentName}`}>
          <span class="seg-dot" aria-hidden="true" />
          <span class="visually-hidden">Segment </span>
          <span class="hd-seg-name">{me.segmentName}</span>
        </span>
      </div>
      <p class="hd-sim" title={me.model.modelId === '' ? 'Model unavailable' : me.model.modelId}>
        {sources} · {model} ·{' '}
        <span class="hd-calls">
          {me.model.callsUsed}/{me.model.callsLimit} calls
        </span>
        {me.readOnly ? <span class="hd-ro"> · Read only</span> : null}
      </p>
    </header>
  );
}
