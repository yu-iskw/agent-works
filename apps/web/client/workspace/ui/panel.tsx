import { pages } from '../../../shared/contract.js';
import { activeTeammate } from '../store/selectors.js';

import { Avatar } from './avatars.jsx';
import { useWorkspace } from './context.js';

import type { JSX } from 'preact';

/** The adaptive panel's frame. Only teammate details are drawn in this unit; the rest come next. */
export function Panel(): JSX.Element {
  const { store, effects } = useWorkspace();
  const state = store.state.value;
  const teammate = activeTeammate(state);
  const panel = state.route.panel;
  const title = panel.kind === 'teammate' ? 'Teammate details' : 'Coming next';
  return (
    <section class="pn" aria-labelledby="pn-title">
      <div class="pn-head">
        <button type="button" class="btn btn-quiet pn-back" onClick={() => effects.back()}>
          ← Back to conversation
        </button>
        <h2 id="pn-title">{title}</h2>
        <button
          type="button"
          class="btn btn-icon pn-close"
          aria-label="Close panel"
          onClick={() => effects.back()}
        >
          <span aria-hidden="true">×</span>
        </button>
      </div>
      <div class="pn-body">
        {teammate === undefined ? (
          <p>Nothing to show.</p>
        ) : panel.kind === 'teammate' ? (
          <div class="pn-teammate">
            <Avatar
              appearance={teammate.appearance}
              id={teammate.id}
              name={teammate.name}
              size={64}
            />
            <h3>{teammate.name}</h3>
            <p class="muted">{teammate.role}</p>
            <p>
              Role, skills, capabilities and export are on the{' '}
              <a href={pages.teammateFallback(state.scope.segment, teammate.id)}>page version</a>{' '}
              until this panel is finished.
            </p>
          </div>
        ) : (
          <p>This view is not built yet.</p>
        )}
      </div>
    </section>
  );
}
