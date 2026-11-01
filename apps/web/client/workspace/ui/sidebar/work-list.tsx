import { TASK_FILTERS } from '../../../../shared/contract.js';
import { teammateForTask } from '../../store/selectors.js';
import { listTime } from '../../store/time.js';
import { Avatar } from '../avatars.jsx';
import { useWorkspace } from '../context.js';

import { ListFoot } from './list-foot.jsx';
import { statusView } from './status.js';

import type { TaskFilter, TaskRow } from '../../../../shared/contract.js';
import type { JSX } from 'preact';

const FILTER_LABEL: Readonly<Record<TaskFilter, string>> = {
  all: 'All',
  running: 'Running',
  attention: 'Needs attention',
  completed: 'Completed',
};

function Filters(): JSX.Element {
  const { store, effects } = useWorkspace();
  const filter = store.lists.value.work.filter;
  return (
    <fieldset class="seg-radio" aria-label="Filter work">
      {TASK_FILTERS.map((name) => (
        <label key={name} class="seg-opt">
          <input
            type="radio"
            name="work-filter"
            value={name}
            checked={filter === name}
            onChange={() => effects.lists.setWorkFilter(name)}
          />
          {/* `name` is the closed TaskFilter enum. */}
          <span>
            {
              // eslint-disable-next-line security/detect-object-injection
              FILTER_LABEL[name]
            }
          </span>
        </label>
      ))}
    </fieldset>
  );
}

function Row(props: {
  readonly task: TaskRow;
  readonly selected: boolean;
  readonly now: Date;
  readonly onOpen: () => void;
}): JSX.Element {
  const { store } = useWorkspace();
  const { task } = props;
  const owner = teammateForTask(store.state.value, task);
  const status = statusView(task.status);
  return (
    <li>
      <button
        type="button"
        class="row"
        aria-current={props.selected ? 'true' : undefined}
        onClick={props.onOpen}
      >
        <span class="row-top">
          <span class="row-title">{task.title}</span>
          <time class="row-time" dateTime={task.updatedAt}>
            {listTime(task.updatedAt, props.now)}
          </time>
        </span>
        <span class="row-meta">
          {owner === undefined ? (
            <span class="row-gone">Teammate unavailable</span>
          ) : (
            <span class="row-who">
              <Avatar appearance={owner.appearance} id={owner.id} name={owner.name} size={20} />
              {owner.name}
            </span>
          )}
          <span class="status" data-tone={status.tone}>
            {status.label}
          </span>
        </span>
      </button>
    </li>
  );
}

export function WorkList(props: { readonly onOpen: () => void }): JSX.Element {
  const { store, effects } = useWorkspace();
  const work = store.lists.value.work;
  const now = new Date();
  return (
    <div class="list">
      <Filters />
      <ul class="rows" aria-label="Work">
        {work.items.map((task) => (
          <Row
            key={task.id}
            task={task}
            selected={work.selected === task.id}
            now={now}
            onOpen={() => {
              effects.lists.openTask(task, { kind: 'task', taskId: task.id });
              props.onOpen();
            }}
          />
        ))}
      </ul>
      <ListFoot
        list="work"
        count={work.items.length}
        empty={work.q === '' ? 'No work here yet.' : 'No work matches your search.'}
      />
    </div>
  );
}
