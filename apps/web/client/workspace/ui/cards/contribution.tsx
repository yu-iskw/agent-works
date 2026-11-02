// A specialist's finished contribution, attributed to that teammate and collapsed by default.

import { taskRoute } from '../../store/panel-routes.js';
import { taskTitle } from '../../store/selectors.js';
import { clockTime } from '../../store/time.js';
import { useWorkspace } from '../context.js';
import { Markdown } from '../markdown.js';

import { ASSIGNMENT_LABEL, ASSIGNMENT_TONE, Chip, Who, useOpen } from './bits.jsx';

import type { TimelineItem } from '@agent-works/domain/teamwork-timeline';
import type { JSX } from 'preact';

type Item = Extract<TimelineItem, { kind: 'contribution' }>;

export function ContributionItem(props: { readonly item: Item }): JSX.Element {
  const { store } = useWorkspace();
  const open = useOpen();
  const { item } = props;
  const failed = item.status === 'failed' || item.status === 'timed_out';
  const id = `ctb-${item.assignmentId}`;
  const title = taskTitle(store.state.value, item.taskId);
  return (
    <li class="ctb" data-status={item.status} id={id}>
      <article aria-labelledby={`${id}-who`}>
        <header class="ctb-head">
          <span id={`${id}-who`}>
            <Who id={item.author.id} name={item.author.name} />
          </span>
          <Chip tone={ASSIGNMENT_TONE[item.status]}>{ASSIGNMENT_LABEL[item.status]}</Chip>
          <time dateTime={item.at}>{clockTime(item.at)}</time>
          {title === undefined ? null : (
            <button
              type="button"
              class="link ctb-for"
              title={title}
              onClick={(event) => open(taskRoute(store.peek().route, item.taskId), event)}
            >
              for {title}
            </button>
          )}
        </header>
        {failed ? (
          <p class="ctb-error">{item.error ?? 'This contribution did not finish.'}</p>
        ) : null}
        {item.question !== null && item.status === 'needs_input' ? (
          <p class="ctb-question">Asked: {item.question}</p>
        ) : null}
        <details class="ctb-details">
          <summary>
            {item.summary === null ? 'Show details' : 'Show contribution'}
            {item.statements > 0 ? (
              <span class="muted">
                {' '}
                · {item.statements} statement{item.statements === 1 ? '' : 's'}
              </span>
            ) : null}
          </summary>
          <div class="ctb-body">
            {item.summary === null ? (
              <p class="muted">No written contribution.</p>
            ) : (
              <Markdown text={item.summary} />
            )}
            <button
              type="button"
              class="btn btn-quiet btn-sm"
              onClick={(event) => open(taskRoute(store.peek().route, item.taskId), event)}
            >
              Open task
            </button>
          </div>
        </details>
      </article>
    </li>
  );
}
