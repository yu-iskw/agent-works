import { pages } from '../../../shared/contract.js';
import { closePanel } from '../store/effects.js';
import { activeTeammate, panelOpen } from '../store/selectors.js';

import { Avatar } from './avatars.jsx';
import { useWorkspace } from './context.js';

import type { JSX } from 'preact';

export function Header(props: { readonly onMenu: () => void }): JSX.Element {
  const { store, effects } = useWorkspace();
  const state = store.state.value;
  const me = state.me;
  const teammate = activeTeammate(state);
  const open = panelOpen(state);
  const route = state.route;
  const toggleDetails = () => {
    if (route.teammate === null) return;
    effects.open(open ? closePanel(route) : { ...route, panel: { kind: 'teammate' } });
  };
  const others = me.segments.filter((s) => s.id !== me.segment);
  return (
    <header class="hd">
      <button
        type="button"
        class="btn btn-icon hd-menu"
        aria-label="Open the sidebar"
        onClick={props.onMenu}
      >
        <span aria-hidden="true">≡</span>
      </button>
      {teammate === undefined ? (
        <div class="hd-who">
          <h1 class="hd-name">{me.segmentName}</h1>
          <p class="hd-role">Choose a teammate to start a conversation.</p>
        </div>
      ) : (
        <div class="hd-who">
          <Avatar
            appearance={teammate.appearance}
            id={teammate.id}
            name={teammate.name}
            size={40}
          />
          <div>
            <h1 class="hd-name">
              {teammate.name}
              {teammate.working ? <span class="hd-state">Working</span> : null}
            </h1>
            <p class="hd-role">{teammate.role}</p>
          </div>
        </div>
      )}
      <div class="hd-right">
        {teammate === undefined ? null : (
          <button type="button" class="btn btn-quiet" aria-pressed={open} onClick={toggleDetails}>
            Details
          </button>
        )}
        <span class="hd-seg" title="Active segment">
          <span class="seg-dot" aria-hidden="true" />
          <span class="visually-hidden">Segment </span>
          {me.segmentName}
          {others.length === 0 ? null : (
            <span class="hd-seg-others">
              {others.map((s) => (
                <a key={s.id} href={pages.segment(s.id)}>
                  {s.name}
                </a>
              ))}
            </span>
          )}
        </span>
        <span
          class="hd-sim"
          title={me.model.modelId === '' ? 'Model unavailable' : me.model.modelId}
        >
          {me.sourceMode === 'fixture' ? 'Demo sources' : 'Live sources'} · Gemini ·{' '}
          <span class="hd-calls">
            {me.model.callsUsed}/{me.model.callsLimit} calls
          </span>
        </span>
      </div>
    </header>
  );
}
