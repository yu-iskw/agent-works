// Loads the task a panel reads and draws the loading, missing and failed states once.

import { taskEntry } from '../../store/task-state.js';
import { useWorkspace } from '../context.js';

import type { TaskDetailPage } from '../../../../shared/contract.js';
import type { ComponentChildren, JSX } from 'preact';

export function TaskGate(props: {
  readonly taskId: string;
  readonly children: (detail: TaskDetailPage) => ComponentChildren;
}): JSX.Element {
  const { store, effects } = useWorkspace();
  const entry = taskEntry(store.state.value.tasks, props.taskId);
  if (entry.detail !== null) return <>{props.children(entry.detail)}</>;
  if (entry.loading || entry.error === null) return <p class="muted">Loading the task…</p>;
  if (entry.error === 'not_found')
    return (
      <p role="alert">
        This task is not available to you. It may belong to another member or segment.
      </p>
    );
  return (
    <div role="alert">
      <p>The segment did not answer ({entry.error}).</p>
      <button
        type="button"
        class="btn btn-quiet btn-sm"
        onClick={() => void effects.tasks.refresh(props.taskId)}
      >
        Try again
      </button>
    </div>
  );
}

/** A fixture document link stays inside the workspace; anything else must be http(s). */
export function externalHref(segment: string, url: string | null): string | undefined {
  if (url === null) return undefined;
  if (url.startsWith('/fixtures/docs/'))
    return `/s/${segment}/fixture-docs/${url.slice('/fixtures/docs/'.length)}`;
  const parsed = URL.parse(url);
  return parsed !== null && (parsed.protocol === 'https:' || parsed.protocol === 'http:')
    ? parsed.href
    : undefined;
}

export function Facts(props: {
  readonly rows: readonly (readonly [string, ComponentChildren])[];
}): JSX.Element {
  return (
    <dl class="facts">
      {props.rows.map(([label, value]) => (
        <div key={label}>
          <dt>{label}</dt>
          <dd>{value}</dd>
        </div>
      ))}
    </dl>
  );
}
