import { pages } from '../../../../shared/contract.js';
import { conversationRoute, formatRoute } from '../../../../shared/route.js';
import { visibleTeammates } from '../../store/selectors.js';
import { listTime } from '../../store/time.js';
import { Avatar } from '../avatars.jsx';
import { useWorkspace } from '../context.js';

import type { TeammateRow } from '../../../../shared/contract.js';
import type { JSX } from 'preact';

function Row(props: {
  readonly row: TeammateRow;
  readonly href: string;
  readonly active: boolean;
  readonly now: Date;
  readonly onOpen: () => void;
}): JSX.Element {
  const { row, active, now } = props;
  const last = row.lastMessage;
  const at = last?.at ?? row.updatedAt;
  return (
    <li>
      <a
        class="tm"
        href={props.href}
        aria-current={active ? 'page' : undefined}
        onClick={(event) => {
          event.preventDefault();
          props.onOpen();
        }}
      >
        <Avatar appearance={row.appearance} id={row.id} name={row.name} size={40} />
        <span class="tm-body">
          <span class="tm-top">
            <span class="tm-name">{row.name}</span>
            <time class="tm-time" dateTime={at}>
              {listTime(at, now)}
            </time>
          </span>
          <span class="tm-role">{row.role}</span>
          <span class="tm-preview">{last === null ? 'No messages yet' : last.text}</span>
          <span class="tm-flags">
            {row.working ? <span class="flag flag-working">Working</span> : null}
            {row.unread ? <span class="flag flag-unread">Unread</span> : null}
            {row.unreadResult ? <span class="flag flag-result">New result</span> : null}
            {row.needsAttention ? <span class="flag flag-attention">Needs you</span> : null}
          </span>
        </span>
      </a>
    </li>
  );
}

export function TeammateList(props: { readonly onOpen: () => void }): JSX.Element {
  const { store, effects } = useWorkspace();
  const state = store.state.value;
  const rows = visibleTeammates(state);
  const segment = state.scope.segment;
  const now = new Date();
  if (state.sidebar.teammates.items.length === 0)
    return (
      <p class="side-empty">
        No teammates yet. <a href={pages.teammates(segment)}>Add a starter team</a> or pick one from
        the <a href={pages.catalog(segment)}>catalog</a>.
      </p>
    );
  if (rows.length === 0) return <p class="side-empty">No teammate matches your search.</p>;
  return (
    <ul class="tm-list" aria-label="Teammates">
      {rows.map((row) => (
        <Row
          key={row.id}
          row={row}
          href={formatRoute(conversationRoute(segment, row.id))}
          now={now}
          active={state.route.teammate === row.id}
          onOpen={() => {
            if (state.route.teammate !== row.id) effects.open(conversationRoute(segment, row.id));
            props.onOpen();
          }}
        />
      ))}
    </ul>
  );
}
