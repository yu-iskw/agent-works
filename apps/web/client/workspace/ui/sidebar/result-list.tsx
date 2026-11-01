import { resultKey } from '../../store/lists.js';
import { teammateById } from '../../store/selectors.js';
import { listTime } from '../../store/time.js';
import { Avatar } from '../avatars.jsx';
import { useWorkspace } from '../context.js';

import { ListFoot } from './list-foot.jsx';

import type { ResultRow } from '../../../../shared/contract.js';
import type { JSX } from 'preact';

function Row(props: {
  readonly row: ResultRow;
  readonly selected: boolean;
  readonly now: Date;
  readonly onOpen: () => void;
}): JSX.Element {
  const { store } = useWorkspace();
  const { row } = props;
  const producer = teammateById(store.state.value, row.producedBy.id);
  return (
    <li>
      <button
        type="button"
        class="row"
        aria-current={props.selected ? 'true' : undefined}
        onClick={props.onOpen}
      >
        <span class="row-top">
          <span class="row-title">{row.title}</span>
          <time class="row-time" dateTime={row.createdAt}>
            {listTime(row.createdAt, props.now)}
          </time>
        </span>
        <span class="row-sub">{row.taskTitle}</span>
        <span class="row-meta">
          <span class="row-who">
            {producer === undefined ? null : (
              <Avatar
                appearance={producer.appearance}
                id={producer.id}
                name={producer.name}
                size={20}
              />
            )}
            {producer?.name ?? row.producedBy.name}
          </span>
          <span class="row-rev">
            Revision {row.revision}
            {row.revision === row.latestRevision ? ' (latest)' : ` of ${row.latestRevision}`}
          </span>
        </span>
      </button>
    </li>
  );
}

export function ResultList(props: { readonly onOpen: () => void }): JSX.Element {
  const { store, effects } = useWorkspace();
  const results = store.lists.value.results;
  const now = new Date();
  return (
    <div class="list">
      <ul class="rows" aria-label="Results">
        {results.items.map((row) => (
          <Row
            key={resultKey(row)}
            row={row}
            selected={results.selected === resultKey(row)}
            now={now}
            onOpen={() => {
              effects.lists.openResult(row);
              props.onOpen();
            }}
          />
        ))}
      </ul>
      <ListFoot
        list="results"
        count={results.items.length}
        empty={results.q === '' ? 'No results yet.' : 'No result matches your search.'}
      />
    </div>
  );
}
