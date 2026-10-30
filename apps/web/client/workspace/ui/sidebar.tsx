import { useEffect, useRef } from 'preact/hooks';

import { SIDEBAR_TABS, THEMES, pages } from '../../../shared/contract.js';
import { conversationRoute, formatRoute } from '../../../shared/route.js';
import { visibleTeammates } from '../store/selectors.js';
import { listTime } from '../store/time.js';

import { Avatar } from './avatars.jsx';
import { useWorkspace } from './context.js';

import type { SidebarTab, TeammateRow, Theme } from '../../../shared/contract.js';
import type { JSX } from 'preact';

const TAB_LABEL: ReadonlyMap<SidebarTab, string> = new Map([
  ['teammates', 'Teammates'],
  ['work', 'Work'],
  ['results', 'Results'],
]);
const tabLabel = (tab: SidebarTab): string => TAB_LABEL.get(tab) ?? tab;

const THEME_LABEL: ReadonlyMap<Theme, string> = new Map([
  ['system', 'System'],
  ['light', 'Light'],
  ['dark', 'Dark'],
]);

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

function Tabs(): JSX.Element {
  const { store, effects } = useWorkspace();
  const tab = store.sidebar.value.tab;
  const onKey = (event: KeyboardEvent) => {
    const delta = event.key === 'ArrowRight' ? 1 : event.key === 'ArrowLeft' ? -1 : 0;
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

function TeammateList(props: { readonly onOpen: () => void }): JSX.Element {
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

function ThemeControl(): JSX.Element {
  const { store, effects } = useWorkspace();
  const theme = store.prefs.value.theme;
  return (
    <fieldset class="theme">
      <legend>Appearance</legend>
      {THEMES.map((name) => (
        <label key={name} class="theme-opt">
          <input
            type="radio"
            name="theme"
            value={name}
            checked={theme === name}
            onChange={() => void effects.setTheme(name)}
          />
          <span>{THEME_LABEL.get(name) ?? name}</span>
        </label>
      ))}
    </fieldset>
  );
}

export function Sidebar(props: { readonly onPick: () => void }): JSX.Element {
  const { store, effects } = useWorkspace();
  const state = store.state.value;
  const { sidebar, scope, me } = state;
  const scroller = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const node = scroller.current;
    if (node !== null) node.scrollTop = sidebar.scroll[sidebar.tab];
  }, [sidebar.tab]);
  const teammate = state.route.teammate;
  return (
    <div class="side">
      <div class="side-top">
        <div class="brand">Agent Works</div>
        <label class="search">
          <span class="visually-hidden">Search teammates</span>
          <input
            type="search"
            placeholder="Search teammates"
            value={sidebar.search}
            onInput={(event) =>
              store.dispatch({ type: 'sidebar/search', text: event.currentTarget.value })
            }
          />
        </label>
        <div class="side-actions">
          <a class="btn btn-primary" href={pages.catalog(scope.segment)}>
            + New
          </a>
          <a class="btn btn-quiet" href={pages.inbox(scope.segment)}>
            Inbox
            {me.inboxOpen > 0 ? <span class="count">{me.inboxOpen}</span> : null}
          </a>
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
            ) : (
              <p class="side-empty">
                {tabLabel(name)} is coming next. Your conversation stays open.
              </p>
            )}
          </div>
        ))}
      </div>
      <div class="side-foot">
        <div class="who">
          <span class="who-name">{me.member.name}</span>
          <span class="who-mail">{me.member.email}</span>
        </div>
        <ThemeControl />
        <div class="side-foot-row">
          {teammate === null ? (
            <span />
          ) : (
            <a class="link" href={pages.teammateFallback(scope.segment, teammate)}>
              Preferences
            </a>
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
