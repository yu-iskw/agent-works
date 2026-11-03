// Execution status of a task's dependency graph. Everything shown comes from the server projection:
// state, reason, retry time, approval need, last update and an authorized result link. The same data
// renders as a keyboard-navigable graph and as a table, which is the accessible fallback.

import { useCallback, useEffect, useMemo, useRef, useState } from 'preact/hooks';

import { ApiFailure, createApi } from '../../api.js';
import {
  CONFLICT_TEXT,
  REASON_LABEL,
  STATE_LABEL,
  isNavKey,
  layers,
  navigate,
  safeHref,
} from '../../store/graph-model.js';
import { createGraphSync } from '../../store/graph-sync.js';
import { clockTime } from '../../store/time.js';
import { useWorkspace } from '../context.js';

import './graph-status.css';

import type { GraphHeld } from '../../store/graph-model.js';
import type { GraphReply, GraphStatusInfo, GraphSync } from '../../store/graph-sync.js';
import type { ProjectionNode } from '@agent-works/domain/teamwork-graph-contract';
import type { JSX } from 'preact';

const POLL_MS = 5000;
const TERMINAL = new Set(['succeeded', 'cancelled']);

type Reply = GraphReply & { readonly segment: string };

function Detail(props: { readonly node: ProjectionNode }): JSX.Element {
  const { node } = props;
  return (
    <>
      <span class="gs-state" data-state={node.state}>
        {STATE_LABEL[node.state]}
      </span>
      {node.reason === null ? null : <span class="gs-reason">{REASON_LABEL[node.reason]}</span>}
      {node.retryAt === null ? null : (
        <span class="gs-reason">
          Next try after <time dateTime={node.retryAt}>{clockTime(node.retryAt)}</time>
        </span>
      )}
      {node.approval === null ? null : (
        <span class="gs-reason">
          {node.approval.kind === 'publish' ? 'Publish approval' : 'Answer'} requested{' '}
          <time dateTime={node.approval.requestedAt}>{clockTime(node.approval.requestedAt)}</time>
        </span>
      )}
    </>
  );
}

function ResultLink(props: { readonly node: ProjectionNode }): JSX.Element | null {
  const { result } = props.node;
  const href = result === null ? undefined : safeHref(result.href);
  return result === null || href === undefined ? null : <a href={href}>{result.label}</a>;
}

function GraphView(props: { readonly nodes: readonly ProjectionNode[] }): JSX.Element {
  const { nodes } = props;
  const [active, setActive] = useState(nodes.at(0)?.key ?? '');
  const refs = useRef(new Map<string, HTMLButtonElement>());
  const current = nodes.some((n) => n.key === active) ? active : (nodes.at(0)?.key ?? '');
  const onKeyDown = (event: KeyboardEvent): void => {
    if (!isNavKey(event.key)) return;
    event.preventDefault();
    const next = navigate(nodes, current, event.key);
    setActive(next);
    refs.current.get(next)?.focus();
  };
  return (
    <div class="gs-graph" onKeyDown={onKeyDown}>
      <p class="muted gs-hint" id="gs-hint">
        Use the arrow keys to move between steps. Left and right follow dependencies.
      </p>
      <ol class="gs-layers" aria-label="Dependency graph, earliest steps first">
        {layers(nodes).map((layer, index) => (
          <li key={index} class="gs-layer">
            <ul>
              {layer.map((node) => (
                <li key={node.key}>
                  <button
                    type="button"
                    class="gs-node"
                    data-state={node.state}
                    data-key={node.key}
                    tabIndex={node.key === current ? 0 : -1}
                    aria-describedby="gs-hint"
                    ref={(el) => {
                      if (el === null) refs.current.delete(node.key);
                      else refs.current.set(node.key, el);
                    }}
                    onFocus={() => setActive(node.key)}
                  >
                    <strong>{node.title}</strong>
                    <Detail node={node} />
                    {node.dependsOn.length === 0 ? null : (
                      <span class="muted">After {node.dependsOn.join(', ')}</span>
                    )}
                  </button>
                  <ResultLink node={node} />
                </li>
              ))}
            </ul>
          </li>
        ))}
      </ol>
    </div>
  );
}

function TableView(props: { readonly nodes: readonly ProjectionNode[] }): JSX.Element {
  return (
    <table class="gs-table">
      <caption>Steps of this task and their status</caption>
      <thead>
        <tr>
          <th scope="col">Step</th>
          <th scope="col">Status</th>
          <th scope="col">Why</th>
          <th scope="col">After</th>
          <th scope="col">Attempt</th>
          <th scope="col">Updated</th>
          <th scope="col">Result</th>
        </tr>
      </thead>
      <tbody>
        {props.nodes.map((node) => (
          <tr key={node.key}>
            <th scope="row">{node.title}</th>
            <td>{STATE_LABEL[node.state]}</td>
            <td>
              {node.reason === null ? '' : REASON_LABEL[node.reason]}
              {node.retryAt === null ? '' : ` (after ${clockTime(node.retryAt)})`}
              {node.approval === null ? '' : ` (${node.approval.kind} approval)`}
            </td>
            <td>{node.dependsOn.join(', ')}</td>
            <td>{node.attempt}</td>
            <td>
              <time dateTime={node.updatedAt}>{clockTime(node.updatedAt)}</time>
            </td>
            <td>
              <ResultLink node={node} />
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function StatusLine(props: {
  readonly info: GraphStatusInfo;
  readonly held: GraphHeld;
}): JSX.Element {
  const { info, held } = props;
  return (
    <p class="muted" role="status">
      {info.loaded ? null : 'Loading the status…'}
      {held === undefined
        ? null
        : `Graph revision ${held.serverRevision}, updated ${clockTime(held.updatedAt)}.`}
      {info.empty ? 'There is no plan to show yet.' : null}
      {info.offline ? ' Connection lost. Showing the last known state; reconnecting.' : null}
    </p>
  );
}

/** First load, polling while visible, and a full refetch when the connection or tab returns. */
function useResync(sync: GraphSync): void {
  useEffect(() => {
    void sync.resync();
    const wake = () => {
      if (!document.hidden) void sync.resync();
    };
    const poll = window.setInterval(wake, POLL_MS);
    window.addEventListener('online', wake);
    document.addEventListener('visibilitychange', wake);
    return () => {
      window.clearInterval(poll);
      window.removeEventListener('online', wake);
      document.removeEventListener('visibilitychange', wake);
    };
  }, [sync]);
}

export function GraphStatus(props: { readonly taskId: string }): JSX.Element {
  const { store } = useWorkspace();
  const { scope } = store.peek();
  const segment = scope.segment;
  const base = `/api/s/${segment}/tasks/${props.taskId}/graph`;
  const api = useMemo(
    () =>
      createApi({
        scope,
        fetch: (input, init) => fetch(input, init),
        onUnauthenticated: () => window.location.assign('/sign-in'),
      }),
    // the scope is fixed for a page load
    [segment, scope.csrf],
  );
  const [held, setHeld] = useState<GraphHeld>(undefined);
  const [info, setInfo] = useState<GraphStatusInfo>({
    loaded: false,
    offline: false,
    empty: false,
  });
  const [view, setView] = useState<'graph' | 'table'>('graph');
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const sync = useMemo(
    () =>
      createGraphSync({
        fetchGraph: () => api.get<Reply>(base),
        onChange: (next, status) => {
          setHeld(next);
          setInfo(status);
        },
      }),
    [api, base],
  );

  useResync(sync);

  const mutate = useCallback(
    async (action: 'cancel' | 'approve') => {
      const graph = sync.held();
      if (graph === undefined) return;
      setBusy(true);
      setNotice(null);
      try {
        sync.receive(
          await api.post<Reply>(`${base}/${action}`, {
            clientRequestId: crypto.randomUUID(),
            cas: {
              taskId: graph.taskId,
              baseRevision: graph.serverRevision,
              expectedDigest: graph.digest,
            },
            taskVersion: graph.taskVersion,
          }),
        );
      } catch (error) {
        const code = error instanceof ApiFailure ? error.code : 'unavailable';
        setNotice(
          // eslint-disable-next-line security/detect-object-injection
          CONFLICT_TEXT[code] ??
            `The segment refused this action (${code}). The view was refreshed.`,
        );
        await sync.resync();
      } finally {
        setBusy(false);
      }
    },
    [api, base, sync],
  );

  const nodes = held?.nodes ?? [];
  const active = nodes.some((n) => !TERMINAL.has(n.state));
  const unapproved = nodes.some((n) => n.reason === 'plan_not_approved');
  return (
    <section class="gs" aria-labelledby="gs-title">
      <h4 id="gs-title">Execution status</h4>
      <StatusLine info={info} held={held} />
      {notice === null ? null : (
        <p class="note" data-tone="error" role="alert">
          {notice}
        </p>
      )}
      {held === undefined ? null : (
        <>
          <div class="gs-views" role="group" aria-label="Status view">
            {(['graph', 'table'] as const).map((choice) => (
              <button
                key={choice}
                type="button"
                class="btn btn-quiet btn-sm"
                aria-pressed={view === choice}
                onClick={() => setView(choice)}
              >
                {choice === 'graph' ? 'Graph' : 'Table'}
              </button>
            ))}
          </div>
          {view === 'graph' ? <GraphView nodes={nodes} /> : <TableView nodes={nodes} />}
          <div class="pn-actions">
            {unapproved ? (
              <button
                type="button"
                class="btn btn-primary"
                disabled={busy}
                onClick={() => void mutate('approve')}
              >
                Approve this revision
              </button>
            ) : null}
            {active ? (
              <button
                type="button"
                class="btn btn-quiet"
                disabled={busy}
                onClick={() => void mutate('cancel')}
              >
                Cancel from this view
              </button>
            ) : null}
          </div>
        </>
      )}
    </section>
  );
}
