import { useEffect, useRef } from 'preact/hooks';

import { SIDEBAR_TABS, pages } from '../../../shared/contract.js';

import { useWorkspace } from './context.js';
import { ResultList } from './sidebar/result-list.jsx';
import { TeammateList } from './sidebar/teammate-list.jsx';
import { WorkList } from './sidebar/work-list.jsx';

import type { SidebarTab } from '../../../shared/contract.js';
import type { JSX } from 'preact';

const TAB_LABEL: ReadonlyMap<SidebarTab, string> = new Map([
  ['teammates', 'Teammates'],
  ['work', 'Work'],
  ['results', 'Results'],
]);
const tabLabel = (tab: SidebarTab): string => TAB_LABEL.get(tab) ?? tab;

const SEARCH_LABEL: Readonly<Record<SidebarTab, string>> = {
  teammates: 'Search teammates',
  work: 'Search work',
  results: 'Search results',
};

function Tabs(): JSX.Element {
  const { store, effects } = useWorkspace();
  const tab = store.sidebar.value.tab;
  const onKey = (event: KeyboardEvent) => {
    const delta =
      event.key === 'ArrowRight'
        ? 1
        : event.key === 'ArrowLeft'
          ? -1
          : event.key === 'Home'
            ? -SIDEBAR_TABS.indexOf(tab)
            : event.key === 'End'
              ? SIDEBAR_TABS.length - 1 - SIDEBAR_TABS.indexOf(tab)
              : 0;
    if (delta === 0) return;
    event.preventDefault();
    const index = SIDEBAR_TABS.indexOf(tab);
    const next = SIDEBAR_TABS[(index + delta + SIDEBAR_TABS.length) % SIDEBAR_TABS.length];
    effects.setTab(next);
    (event.currentTarget as HTMLElement).querySelector<HTMLElement>(`#tab-${next}`)?.focus();
  };
  return (
    <div class="tabs" role="tablist" aria-label="Sidebar views" onKeyDown={onKey}>
      {SIDEBAR_TABS.map((name) => (
        <button
          key={name}
          id={`tab-${name}`}
          type="button"
          role="tab"
          class="tab"
          aria-selected={tab === name}
          aria-controls={`tabpanel-${name}`}
          tabIndex={tab === name ? 0 : -1}
          onClick={() => effects.setTab(name)}
        >
          {tabLabel(name)}
        </button>
      ))}
    </div>
  );
}

/** Each tab keeps its own query: Teammates filters the loaded rows, Work and Results ask the segment. */
function Search(): JSX.Element {
  const { store, effects } = useWorkspace();
  const state = store.state.value;
  const tab = state.sidebar.tab;
  const value =
    tab === 'teammates'
      ? state.sidebar.search
      : tab === 'work'
        ? state.lists.work.q
        : state.lists.results.q;
  const onInput = (text: string) => {
    if (tab === 'teammates') store.dispatch({ type: 'sidebar/search', text });
    else effects.lists.search(tab, text);
  };
  // `tab` is the closed SidebarTab enum.
  // eslint-disable-next-line security/detect-object-injection
  const label = SEARCH_LABEL[tab];
  return (
    <label class="search">
      <span class="visually-hidden">{label}</span>
      <input
        type="search"
        placeholder={label}
        value={value}
        onInput={(event) => onInput(event.currentTarget.value)}
      />
    </label>
  );
}

export function Sidebar(props: {
  readonly onPick: () => void;
  /** True when the sidebar is the phone sheet, which carries its own close control. */
  readonly sheet: boolean;
}): JSX.Element {
  const { store, effects } = useWorkspace();
  const state = store.state.value;
  const { sidebar, scope, me, route } = state;
  const scroller = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const node = scroller.current;
    // `tab` is the closed SidebarTab enum.

    if (node !== null) node.scrollTop = sidebar.scroll[sidebar.tab];
  }, [sidebar.tab]);
  useEffect(() => {
    if (sidebar.tab !== 'teammates') effects.lists.ensure(sidebar.tab);
  }, [sidebar.tab, effects]);
  const others = me.segments.filter((s) => s.id !== me.segment);
  const openPanel = (kind: 'inbox' | 'preferences') => {
    if (route.teammate === null) return;
    effects.open({ ...route, panel: { kind } });
    props.onPick();
  };
  const inboxLabel =
    me.inboxOpen === 0
      ? 'Inbox'
      : `Inbox ${me.inboxOpen} open item${me.inboxOpen === 1 ? '' : 's'}`;
  return (
    <div class="side">
      <div class="side-top">
        <div class="side-brand">
          <span class="brand">Agent Works</span>
          {props.sheet ? (
            <button
              type="button"
              class="btn btn-icon btn-sm"
              aria-label="Close the sidebar"
              onClick={props.onPick}
            >
              <span aria-hidden="true">×</span>
            </button>
          ) : null}
        </div>
        <Search />
        <div class="side-actions">
          <a class="btn btn-primary" href={pages.catalog(scope.segment)}>
            + New
          </a>
          {route.teammate === null ? (
            <a class="btn btn-quiet" href={pages.inbox(scope.segment)} aria-label={inboxLabel}>
              Inbox {me.inboxOpen > 0 ? <span class="count">{me.inboxOpen}</span> : null}
            </a>
          ) : (
            <button
              type="button"
              class="btn btn-quiet"
              aria-label={inboxLabel}
              aria-pressed={route.panel.kind === 'inbox'}
              onClick={() => openPanel('inbox')}
            >
              Inbox {me.inboxOpen > 0 ? <span class="count">{me.inboxOpen}</span> : null}
            </button>
          )}
        </div>
        <Tabs />
      </div>
      <div
        class="side-scroll"
        ref={scroller}
        onScroll={(event) =>
          store.dispatch({
            type: 'sidebar/scroll',
            tab: sidebar.tab,
            top: event.currentTarget.scrollTop,
          })
        }
      >
        {SIDEBAR_TABS.map((name) => (
          <div
            key={name}
            id={`tabpanel-${name}`}
            role="tabpanel"
            aria-labelledby={`tab-${name}`}
            hidden={sidebar.tab !== name}
          >
            {name === 'teammates' ? (
              <TeammateList onOpen={props.onPick} />
            ) : name === 'work' ? (
              <WorkList onOpen={props.onPick} />
            ) : (
              <ResultList onOpen={props.onPick} />
            )}
          </div>
        ))}
      </div>
      <div class="side-foot">
        <div class="who">
          <span class="who-name">{me.member.name}</span>
          <span class="who-mail">{me.member.email}</span>
        </div>
        {others.length === 0 ? null : (
          <p class="who-segments">
            Other segments:{' '}
            {others.map((s) => (
              <a key={s.id} href={pages.segment(s.id)}>
                {s.name}
              </a>
            ))}
          </p>
        )}
        <div class="side-foot-row">
          {route.teammate === null ? (
            <span />
          ) : (
            <button type="button" class="link" onClick={() => openPanel('preferences')}>
              Preferences
            </button>
          )}
          <form method="post" action={pages.signOut} onSubmit={() => effects.beforeSignOut()}>
            <input type="hidden" name="csrf" value={scope.csrf} />
            <button type="submit" class="link">
              Sign out
            </button>
          </form>
        </div>
      </div>
    </div>
  );
}
