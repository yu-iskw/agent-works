// The coordinator recap startup view: what needs a decision, what is running, what finished.
// Everything here is read from persisted state through the BFF; no model call is made.

import { useEffect, useState } from 'preact/hooks';

import { listTime } from '../../store/time.js';
import { useWorkspace } from '../context.js';
import { statusView } from '../sidebar/status.js';

import type { RecapView } from '../../../../shared/contract.js';
import type { JSX } from 'preact';

type Load =
  | { readonly state: 'loading' }
  | { readonly state: 'error' }
  | { readonly state: 'ready'; readonly recap: RecapView };

export function RecapPanel(): JSX.Element {
  const { effects } = useWorkspace();
  const [load, setLoad] = useState<Load>({ state: 'loading' });
  useEffect(() => {
    let live = true;
    effects.lists
      .recap()
      .then((recap) => live && setLoad({ state: 'ready', recap }))
      .catch(() => live && setLoad({ state: 'error' }));
    return () => {
      live = false;
    };
  }, [effects]);
  if (load.state === 'loading')
    return (
      <p class="side-empty" aria-live="polite">
        Gathering your recap…
      </p>
    );
  if (load.state === 'error')
    return (
      <p class="side-empty" role="alert">
        The recap could not be loaded. Your conversations are still available in the sidebar.
      </p>
    );
  const { recap } = load;
  const now = new Date();
  const quiet =
    recap.decisions.length === 0 && recap.running.length === 0 && recap.results.length === 0;
  return (
    <div class="recap">
      <p class="muted">A summary from your inbox and work records. No model was called.</p>
      {quiet ? (
        <p class="side-empty">Nothing is waiting on you, nothing is running, and no results yet.</p>
      ) : null}
      <section aria-label="Needs your decision">
        <h3 class="inbox-title">
          Needs your decision <span class="inbox-n">({recap.counts.decisions})</span>
        </h3>
        {recap.decisions.length === 0 ? (
          <p class="side-empty">No open decisions.</p>
        ) : (
          <ul class="rows">
            {recap.decisions.map((item) => (
              <li key={item.id}>
                <button
                  type="button"
                  class="row"
                  onClick={() => void effects.lists.openInboxItem(item)}
                >
                  <span class="row-top">
                    <span class="row-title">{item.taskTitle}</span>
                    <time class="row-time" dateTime={item.createdAt}>
                      {listTime(item.createdAt, now)}
                    </time>
                  </span>
                  <span class="row-sub">{item.summary}</span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>
      <section aria-label="Running work">
        <h3 class="inbox-title">
          Running <span class="inbox-n">({recap.counts.running})</span>
        </h3>
        {recap.running.length === 0 ? (
          <p class="side-empty">Nothing is running.</p>
        ) : (
          <ul class="rows">
            {recap.running.map((task) => (
              <li key={task.id}>
                <button
                  type="button"
                  class="row"
                  onClick={() => effects.lists.openTask(task, { kind: 'task', taskId: task.id })}
                >
                  <span class="row-top">
                    <span class="row-title">{task.title}</span>
                    <time class="row-time" dateTime={task.updatedAt}>
                      {listTime(task.updatedAt, now)}
                    </time>
                  </span>
                  <span class="row-meta">
                    <span class="status" data-tone={statusView(task.status).tone}>
                      {statusView(task.status).label}
                    </span>
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>
      <section aria-label="Recent results">
        <h3 class="inbox-title">Recent results</h3>
        {recap.results.length === 0 ? (
          <p class="side-empty">No results yet.</p>
        ) : (
          <ul class="rows">
            {recap.results.map((row) => (
              <li key={`${row.taskId}:${row.revision}`}>
                <button type="button" class="row" onClick={() => effects.lists.openResult(row)}>
                  <span class="row-top">
                    <span class="row-title">{row.title}</span>
                    <time class="row-time" dateTime={row.createdAt}>
                      {listTime(row.createdAt, now)}
                    </time>
                  </span>
                  <span class="row-sub">
                    {row.producedBy.name} · Revision {row.revision}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
