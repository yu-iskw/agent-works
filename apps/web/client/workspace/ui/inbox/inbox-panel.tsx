// The attention inbox: open items grouped into decisions and results. Opening an item navigates;
// only the real action in the review panel resolves it, so an item stays here until then.

import { useEffect } from 'preact/hooks';

import { groupInbox } from '../../store/selectors.js';
import { listTime } from '../../store/time.js';
import { useWorkspace } from '../context.js';
import { ListFoot } from '../sidebar/list-foot.jsx';

import type { InboxRow } from '../../../../shared/contract.js';
import type { JSX } from 'preact';

const KIND_LABEL: Readonly<Record<InboxRow['kind'], string>> = {
  question: 'Answer question',
  plan_review: 'Review plan',
  approval: 'Review action',
  completed: 'Open result',
  failed: 'See failure',
  uncertain: 'Check outcome',
};

function Item(props: { readonly item: InboxRow; readonly now: Date }): JSX.Element {
  const { effects, store } = useWorkspace();
  const { item } = props;
  const selected = store.lists.value.inbox.selected === item.id;
  return (
    <li>
      <button
        type="button"
        class="row"
        data-task={item.taskId}
        aria-current={selected ? 'true' : undefined}
        onClick={() => void effects.lists.openInboxItem(item)}
      >
        <span class="row-top">
          <span class="row-title">{item.taskTitle}</span>
          <time class="row-time" dateTime={item.createdAt}>
            {listTime(item.createdAt, props.now)}
          </time>
        </span>
        <span class="row-sub">{item.summary}</span>
        <span class="row-meta">
          <span class="row-action">{KIND_LABEL[item.kind]}</span>
        </span>
      </button>
    </li>
  );
}

function Group(props: {
  readonly title: string;
  readonly items: readonly InboxRow[];
  readonly empty: string;
  readonly now: Date;
}): JSX.Element {
  return (
    <section class="inbox-group" aria-label={props.title}>
      <h3 class="inbox-title">
        {props.title} <span class="inbox-n">({props.items.length})</span>
      </h3>
      {props.items.length === 0 ? (
        <p class="side-empty">{props.empty}</p>
      ) : (
        <ul class="rows">
          {props.items.map((item) => (
            <Item key={item.id} item={item} now={props.now} />
          ))}
        </ul>
      )}
    </section>
  );
}

export function InboxPanel(): JSX.Element {
  const { store, effects } = useWorkspace();
  const inbox = store.lists.value.inbox;
  useEffect(() => {
    effects.lists.reload('inbox');
  }, [effects]);
  const groups = groupInbox(inbox.items);
  const now = new Date();
  return (
    <div class="inbox">
      <p class="muted">Items that need your review or input. Opening one never resolves it.</p>
      {inbox.status === 'ready' && inbox.items.length === 0 ? (
        <p class="side-empty">Nothing needs you right now.</p>
      ) : (
        <>
          <Group
            title="Needs your decision"
            items={groups.decisions}
            empty="No open decisions."
            now={now}
          />
          <Group title="Results" items={groups.results} empty="No new results." now={now} />
        </>
      )}
      <ListFoot list="inbox" count={inbox.items.length} empty="" />
    </div>
  );
}
