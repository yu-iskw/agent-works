import { useWorkspace } from '../context.js';

import type { ListName } from '../../store/lists.js';
import type { JSX } from 'preact';

/** The bottom of a paged list: the next-page control, the loading state, or the retry. */
export function ListFoot(props: {
  readonly list: ListName;
  readonly count: number;
  readonly empty: string;
}): JSX.Element | null {
  const { store, effects } = useWorkspace();
  const list = store.lists.value[props.list];
  if (list.status === 'error')
    return (
      <p class="side-empty" role="alert">
        Could not load this list.{' '}
        <button type="button" class="link" onClick={() => effects.lists.reload(props.list)}>
          Try again
        </button>
      </p>
    );
  if (list.status === 'loading' && props.count === 0)
    return (
      <p class="side-empty" aria-live="polite">
        Loading…
      </p>
    );
  if (list.status === 'ready' && props.count === 0) return <p class="side-empty">{props.empty}</p>;
  if (list.nextCursor === null) return null;
  return (
    <div class="list-more">
      <button
        type="button"
        class="btn btn-quiet btn-sm"
        disabled={list.status === 'loading'}
        onClick={() => effects.lists.loadMore(props.list)}
      >
        {list.status === 'loading' ? 'Loading…' : 'Load more'}
      </button>
    </div>
  );
}
