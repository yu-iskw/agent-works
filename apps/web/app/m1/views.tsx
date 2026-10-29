import { Fragment, h } from '../html.js';
import { Icon } from '../workbench/icons.js';

import {
  CAPABILITY,
  INBOX,
  TASK_STATUS,
  WORKFLOW,
  capabilityLabel,
  errorText,
  when,
  workflowInfo,
} from './labels.js';

import type { Connection, Conversation, ExportPreview, Readiness } from './api.js';
import type { Segment } from './config.js';
import type { Session } from './identity.js';
import type { Child, Html } from '../html.js';
import type { IconName } from '../workbench/icons.js';
import type {
  CapabilityState,
  InboxItem,
  SkillView,
  TaskSummary,
  TeammateView,
  TemplateView,
} from '@agent-works/domain/teamwork';

export type NavKey = 'inbox' | 'teammates' | 'tasks' | 'catalog' | 'connections' | 'none';

export type Notice = { readonly tone: 'ok' | 'danger' | 'info' | 'warn'; readonly text: string };

export type PageCtx = {
  readonly session: Session;
  readonly segment: Segment;
  readonly segments: readonly Segment[];
  readonly readiness: Readiness | undefined;
  readonly nav: NavKey;
  readonly notice?: Notice;
};

export const segPath = (segment: Segment | string, path = '') =>
  `/s/${typeof segment === 'string' ? segment : segment.id}${path}`;

export const TEAMMATES_PATH = '/teammates';
export const NEW_TASK_PATH = '/tasks/new';

export function Csrf(props: { readonly session: Session }): Html {
  return <input type="hidden" name="csrf" value={props.session.csrf} />;
}

export function Status(props: { readonly status: TaskSummary['status'] }): Html {
  const info = TASK_STATUS[props.status];
  return <span class={`status status-${info.tone}`}>{info.label}</span>;
}

export function SubmitButton(props: {
  readonly label: string;
  readonly kind?: string;
  readonly name?: string;
  readonly value?: string;
  readonly small?: boolean;
}): Html {
  return (
    <button
      class={`btn ${props.kind ?? 'btn-primary'}${props.small === true ? ' btn-sm' : ''}`}
      type="submit"
      name={props.name}
      value={props.value}
      data-submit="once"
    >
      <span class="spinner" aria-hidden="true"></span>
      {props.label}
    </button>
  );
}

export function Alert(props: {
  readonly tone: Notice['tone'];
  readonly title?: string;
  readonly children?: readonly Child[];
  readonly live?: boolean;
}): Html {
  const icon: IconName =
    props.tone === 'ok'
      ? 'check'
      : props.tone === 'danger'
        ? 'alert'
        : props.tone === 'warn'
          ? 'alert'
          : 'info';
  return (
    <div
      class={`alert alert-${props.tone}`}
      role={props.live === false ? undefined : props.tone === 'danger' ? 'alert' : 'status'}
    >
      <Icon name={icon} />
      <div>
        {props.title === undefined ? null : <h2>{props.title}</h2>}
        {props.children}
      </div>
    </div>
  );
}

function SegmentSwitch(props: { readonly ctx: PageCtx }): Html {
  const { ctx } = props;
  return (
    <details class="segment-switch" data-segment-switch>
      <summary aria-label={`Active segment: ${ctx.segment.name}. Switch segment`}>
        <span class="segment-dot" aria-hidden="true"></span>
        <span>{ctx.segment.name}</span>
      </summary>
      <div class="segment-menu" role="menu">
        {ctx.segments.map((segment) => (
          <a
            role="menuitem"
            href={segPath(segment, '/inbox')}
            aria-current={segment.id === ctx.segment.id ? 'true' : undefined}
            data-segment-tone={segment.id}
          >
            <span class="segment-dot" aria-hidden="true"></span>
            <span>{segment.name}</span>
            {segment.id === ctx.segment.id ? <span class="subtle">(current)</span> : null}
          </a>
        ))}
        <p>
          Each segment has its own teammates, tasks, catalog and connections. Unsent drafts stay in
          the segment where you wrote them.
        </p>
      </div>
    </details>
  );
}

const NAV: readonly { key: NavKey; label: string; icon: IconName; path: string }[] = [
  { key: 'inbox', label: 'Inbox', icon: 'inbox', path: '/inbox' },
  { key: 'teammates', label: 'Teammates', icon: 'sparkle', path: TEAMMATES_PATH },
  { key: 'tasks', label: 'Tasks', icon: 'list', path: '/tasks' },
  { key: 'catalog', label: 'Catalog', icon: 'file', path: '/catalog' },
  { key: 'connections', label: 'Connections', icon: 'plug', path: '/connections' },
];

/** Non-live modes, shown in the segment bar so they stay visible at every width. */
function modeLabels(ctx: PageCtx): readonly string[] {
  const r = ctx.readiness;
  return [
    ...(ctx.session.idp === 'local-test' ? ['Local test identity'] : []),
    ...(r?.sourceMode === 'fixture' ? ['Fixture sources'] : []),
    ...(r?.model.mode === 'stub' ? ['Scripted model, no Vertex calls'] : []),
  ];
}

export function Shell(props: {
  readonly ctx: PageCtx;
  readonly title: string;
  readonly children?: readonly Child[];
}): Html {
  const { ctx } = props;
  const r = ctx.readiness;
  const open = Object.values(r?.inbox ?? {}).reduce((sum, n) => sum + n, 0);
  return (
    <Fragment>
      <a class="skip-link" href="#main">
        Skip to content
      </a>
      <div class="shell" data-segment-tone={ctx.segment.id}>
        <header class="topbar">
          <button
            class="btn btn-ghost btn-sm menu-button"
            type="button"
            aria-controls="sidenav"
            aria-expanded="false"
            data-nav-toggle
          >
            <Icon name="menu" />
            <span class="sr-only">Menu</span>
          </button>
          <a
            class="brand"
            href={segPath(ctx.segment, '/inbox')}
            aria-label="Agent Works, go to inbox"
          >
            <span class="brand-mark" aria-hidden="true">
              AW
            </span>
            <span>Agent Works</span>
          </a>
          <SegmentSwitch ctx={ctx} />
          <span class="topbar-spacer"></span>
          <div class="env-badges">
            {r === undefined ? null : (
              <span
                class={`badge ${r.model.state === 'error' ? 'badge-bad' : 'badge-model'} badge-hide-sm`}
                title="Real Vertex AI calls used by this segment"
              >
                {r.model.modelId} · {r.model.callsUsed}/{r.model.callsLimit} calls
              </span>
            )}
          </div>
          <div class="user-chip">
            <span class="avatar" aria-hidden="true">
              {ctx.session.email.slice(0, 1)}
            </span>
            <span class="user-email">{ctx.session.email}</span>
            <form method="post" action="/auth/sign-out">
              <Csrf session={ctx.session} />
              <button class="btn btn-ghost btn-sm" type="submit">
                <Icon name="logout" small />
                <span class="sr-only">Sign out</span>
              </button>
            </form>
          </div>
        </header>
        <div class="segment-bar" role="note" aria-label="Active segment">
          <span class="segment-dot" aria-hidden="true"></span>
          <span>
            Segment <strong>{ctx.segment.name}</strong>
          </span>
          <span class="hide-sm subtle">
            Data, teammates, catalog and connections here are separate from every other segment.
          </span>
          {modeLabels(ctx).length === 0 ? null : (
            <span class="mode-labels" aria-label="Test modes in use">
              {modeLabels(ctx).map((label) => (
                <span class="badge badge-test">{label}</span>
              ))}
            </span>
          )}
        </div>
        <nav class="sidenav" id="sidenav" aria-label="Main">
          <div class="nav-new">
            <a class="btn btn-primary btn-sm" href={segPath(ctx.segment, NEW_TASK_PATH)}>
              <Icon name="plus" small />
              New task
            </a>
          </div>
          <ul>
            {NAV.map((item) => (
              <li>
                <a
                  class="nav-link"
                  href={segPath(ctx.segment, item.path)}
                  aria-current={ctx.nav === item.key ? 'page' : undefined}
                >
                  <Icon name={item.icon} />
                  {item.label}
                  {item.key === 'inbox' && open > 0 ? (
                    <span class="nav-count" aria-label={`${open} open`}>
                      {open}
                    </span>
                  ) : null}
                </a>
              </li>
            ))}
          </ul>
        </nav>
        <main class="main" id="main" tabindex="-1" data-segment={ctx.segment.id}>
          {ctx.notice === undefined ? null : (
            <div class="notice">
              <Alert tone={ctx.notice.tone}>
                <p>{ctx.notice.text}</p>
              </Alert>
            </div>
          )}
          {r !== undefined && r.missingConfig.length > 0 ? (
            <div class="notice">
              <Alert tone="warn" title="This segment is not fully configured">
                <p>
                  Missing settings: <code>{r.missingConfig.join(', ')}</code>. Live work that needs
                  them will stop with an explanation. See <code>docs/m1/SETUP_OAUTH.md</code> and{' '}
                  <code>docs/m1/SETUP_RESOURCES.md</code>.
                </p>
              </Alert>
            </div>
          ) : null}
          {props.children}
        </main>
      </div>
    </Fragment>
  );
}

export function PageHead(props: {
  readonly title: string;
  readonly lead?: string;
  readonly children?: readonly Child[];
  readonly crumbs?: readonly { label: string; href: string }[];
}): Html {
  return (
    <div class="page-head">
      <div>
        {props.crumbs === undefined ? null : (
          <nav class="breadcrumbs" aria-label="Breadcrumb">
            <ol>
              {props.crumbs.map((crumb) => (
                <li>
                  <a href={crumb.href}>{crumb.label}</a>
                </li>
              ))}
            </ol>
          </nav>
        )}
        <h1>{props.title}</h1>
        {props.lead === undefined ? null : <p>{props.lead}</p>}
      </div>
      {props.children === undefined ? null : <div class="row">{props.children}</div>}
    </div>
  );
}

function Empty(props: {
  readonly icon: IconName;
  readonly title: string;
  readonly children?: readonly Child[];
}): Html {
  return (
    <div class="card">
      <div class="empty">
        <Icon name={props.icon} />
        <h2>{props.title}</h2>
        <div class="stack-sm">{props.children}</div>
      </div>
    </div>
  );
}

export function InboxPage(props: {
  readonly ctx: PageCtx;
  readonly items: readonly InboxItem[];
}): Html {
  const { ctx } = props;
  const open = props.items.filter((item) => item.state === 'open');
  const groups = [
    { key: 'decide', title: 'Needs your decision' },
    { key: 'problems', title: 'Problems to resolve' },
    { key: 'results', title: 'Results' },
  ] as const;
  const resolved = props.items.filter((item) => item.state !== 'open').slice(0, 20);
  return (
    <Shell ctx={ctx} title="Inbox">
      <PageHead
        title="Inbox"
        lead="Questions, approvals, results and problems from your teammates in this segment. Resolving an item here or on its task resolves it everywhere."
      />
      {open.length === 0 ? (
        <Empty icon="inbox" title="Nothing needs you right now">
          <p class="muted">
            Delegate work and come back later. Questions, plans to review, approvals and finished
            results will appear here.
          </p>
          <p>
            <a class="btn btn-primary" href={segPath(ctx.segment, NEW_TASK_PATH)}>
              Start a task
            </a>
          </p>
        </Empty>
      ) : (
        groups.map((group) => {
          const items = open.filter((item) => INBOX[item.kind].group === group.key);
          if (items.length === 0) return null;
          return (
            <section class="inbox-group" aria-labelledby={`g-${group.key}`}>
              <h2 class="section-title" id={`g-${group.key}`}>
                {group.title} ({items.length})
              </h2>
              <div class="card">
                {items.map((item) => (
                  <div class="inbox-item">
                    <span class="inbox-kind" data-kind={item.kind} aria-hidden="true">
                      <Icon
                        name={
                          item.kind === 'completed'
                            ? 'check'
                            : item.kind === 'failed' || item.kind === 'uncertain'
                              ? 'alert'
                              : 'clock'
                        }
                        small
                      />
                    </span>
                    <div>
                      <a
                        class="title"
                        href={segPath(ctx.segment, `/tasks/${item.taskId}#decision`)}
                      >
                        {item.taskTitle}
                      </a>
                      <p class="muted">
                        <span class="badge badge-neutral">{INBOX[item.kind].label}</span>{' '}
                        {item.summary}
                      </p>
                      <p class="subtle">{when(item.createdAt)}</p>
                    </div>
                    <div class="row">
                      <a
                        class="btn btn-sm"
                        href={segPath(ctx.segment, `/tasks/${item.taskId}#decision`)}
                      >
                        Open
                      </a>
                      {item.kind === 'completed' ? (
                        <form
                          method="post"
                          action={segPath(ctx.segment, `/inbox/${item.id}/dismiss`)}
                        >
                          <Csrf session={ctx.session} />
                          <SubmitButton label="Dismiss" kind="btn-ghost" small />
                        </form>
                      ) : null}
                    </div>
                  </div>
                ))}
              </div>
            </section>
          );
        })
      )}
      {resolved.length === 0 ? null : (
        <details class="card footer-note">
          <summary class="card-body">Recently resolved ({resolved.length})</summary>
          <ul class="task-list">
            {resolved.map((item) => (
              <li class="task-item">
                <a class="task-title" href={segPath(ctx.segment, `/tasks/${item.taskId}`)}>
                  {item.taskTitle}
                </a>
                <span class="badge badge-neutral">{item.state}</span>
                <div class="task-meta">
                  <span>
                    {INBOX[item.kind].label}: {item.summary}
                  </span>
                  <span>{when(item.resolvedAt)}</span>
                </div>
              </li>
            ))}
          </ul>
        </details>
      )}
    </Shell>
  );
}

function CapabilityChips(props: {
  readonly states: readonly CapabilityState[];
  readonly requestedOnly?: boolean;
}): Html {
  return (
    <div class="chips" aria-label="Capabilities">
      {props.states
        .filter((state) => props.requestedOnly !== true || state.requested)
        .map((state) => (
          <span
            class={`chip ${state.effective ? 'chip-on' : 'chip-off'}`}
            title={state.reason ?? 'Available'}
          >
            {CAPABILITY[state.capability]}
            <span class="sr-only">
              {state.effective ? ' (available)' : ` (not available: ${state.reason ?? ''})`}
            </span>
          </span>
        ))}
    </div>
  );
}

export function TeammatesPage(props: {
  readonly ctx: PageCtx;
  readonly teammates: readonly TeammateView[];
}): Html {
  const { ctx } = props;
  return (
    <Shell ctx={ctx} title="Teammates">
      <PageHead
        title="Teammates"
        lead="Your personal AI specialists in this segment. Each is a private copy of a curated template that you can customize."
      >
        <a class="btn" href={segPath(ctx.segment, '/catalog')}>
          Add from catalog
        </a>
        <a class="btn btn-ghost" href={segPath(ctx.segment, '/import')}>
          Import definition
        </a>
      </PageHead>
      {props.teammates.length === 0 ? (
        <Empty icon="sparkle" title="You have no teammates in this segment yet">
          <p class="muted">
            Start with one copy of every curated template: research, risk, data, context,
            requirements, engineering and a coordinator.
          </p>
          <form method="post" action={segPath(ctx.segment, '/teammates/starter')}>
            <Csrf session={ctx.session} />
            <SubmitButton label="Add the starter team" />
          </form>
        </Empty>
      ) : (
        <div class="cards">
          {props.teammates.map((tm) => (
            <article class="card tm-card">
              <div>
                <h2>
                  <a href={segPath(ctx.segment, `/teammates/${tm.id}`)}>{tm.name}</a>
                </h2>
                <p class="muted">{tm.role}</p>
              </div>
              <div>
                <p class="section-title">Skills</p>
                <div class="chips">
                  {tm.skills.length === 0 ? (
                    <span class="subtle">No skills attached</span>
                  ) : (
                    tm.skills.map((skill) => (
                      <span class="chip">
                        {skill.name} v{skill.version}
                      </span>
                    ))
                  )}
                </div>
              </div>
              <div>
                <p class="section-title">Capabilities</p>
                <CapabilityChips states={tm.capabilities} requestedOnly />
              </div>
              <p class="subtle">
                From {tm.template.name} v{tm.template.version}
                {tm.origin === 'imported' ? ' (imported)' : ''} · version {tm.version}
              </p>
            </article>
          ))}
        </div>
      )}
    </Shell>
  );
}

function Bubble(props: {
  readonly role: string;
  readonly name: string;
  readonly text: string;
  readonly at: string;
  readonly children?: readonly Child[];
}): Html {
  return (
    <div class={`msg msg-${props.role}`}>
      <span class="avatar" aria-hidden="true">
        {props.name.slice(0, 1)}
      </span>
      <div>
        <div class="turn-head">
          <strong>{props.name}</strong>
          <span>{when(props.at)}</span>
        </div>
        <div class="bubble">{props.text}</div>
        {props.children}
      </div>
    </div>
  );
}

function ConversationPanel(props: {
  readonly ctx: PageCtx;
  readonly teammate: TeammateView;
  readonly conversation: Conversation;
  readonly draft?: string;
}): Html {
  const { ctx, teammate, conversation } = props;
  return (
    <section class="card" aria-labelledby="conv-h" data-live="conversation">
      <div class="panel-head">
        <h2 id="conv-h">Conversation with {teammate.name}</h2>
        {conversation.pendingReply ? (
          <span class="status status-active" role="status">
            {teammate.name} is replying
          </span>
        ) : null}
      </div>
      <div class="panel-body">
        <div class="msgs" aria-live="polite" aria-relevant="additions">
          {conversation.messages.length === 0 ? (
            <p class="muted">
              No messages yet. Ask {teammate.name} how they would approach something, then start a
              task from here.
            </p>
          ) : null}
          {conversation.messages.map((message) => (
            <Bubble
              role={message.role}
              name={
                message.role === 'member'
                  ? 'You'
                  : message.role === 'system'
                    ? 'Workbench'
                    : teammate.name
              }
              text={message.text}
              at={message.at}
            >
              {message.card === null ? null : (
                <a class="card-link" href={segPath(ctx.segment, `/tasks/${message.card.taskId}`)}>
                  <Icon name="external" small />
                  Open task: {message.card.title}
                </a>
              )}
            </Bubble>
          ))}
        </div>
        <form
          class="stack-sm"
          method="post"
          action={segPath(ctx.segment, `/teammates/${teammate.id}/messages`)}
          data-draft={`conv-${teammate.id}`}
        >
          <Csrf session={ctx.session} />
          <input type="hidden" name="clientRequestId" value={crypto.randomUUID()} />
          <div class="field">
            <label for="msg">Message</label>
            <textarea
              id="msg"
              name="text"
              required
              maxlength="4000"
              placeholder={`Ask ${teammate.name} something`}
              data-ctrl-enter
            >
              {props.draft ?? ''}
            </textarea>
            <p class="hint">
              Conversations cannot read sources. For work on documents, metrics or code, start a
              task; it stays linked to this conversation.
            </p>
          </div>
          <div class="row">
            <SubmitButton label="Send" />
            <a
              class="btn"
              href={`${segPath(ctx.segment, NEW_TASK_PATH)}?owner=${teammate.id}&conversation=${conversation.id}`}
            >
              Start a task from this conversation
            </a>
          </div>
        </form>
      </div>
    </section>
  );
}

export function TeammatePage(props: {
  readonly ctx: PageCtx;
  readonly teammate: TeammateView;
  readonly conversation: Conversation;
  readonly skills: readonly SkillView[];
}): Html {
  const { ctx, teammate, conversation } = props;
  const attached = new Set(teammate.skills.map((s) => s.id));
  const available = props.skills.filter((skill) => !attached.has(skill.id));
  return (
    <Shell ctx={ctx} title={teammate.name}>
      <PageHead
        title={teammate.name}
        lead={teammate.role}
        crumbs={[{ label: 'Teammates', href: segPath(ctx.segment, TEAMMATES_PATH) }]}
      >
        <a class="btn" href={segPath(ctx.segment, `/teammates/${teammate.id}/export`)}>
          <Icon name="download" small />
          Export definition
        </a>
      </PageHead>
      <div class="task-layout">
        <div class="stack">
          <ConversationPanel ctx={ctx} teammate={teammate} conversation={conversation} />
          <section class="card" aria-labelledby="tasks-h">
            <div class="panel-head">
              <h2 id="tasks-h">Work with {teammate.name}</h2>
            </div>
            {conversation.tasks.length === 0 ? (
              <p class="panel-body muted">No tasks yet.</p>
            ) : (
              <ul class="task-list">
                {conversation.tasks.map((task) => (
                  <li class="task-item">
                    <a class="task-title" href={segPath(ctx.segment, `/tasks/${task.id}`)}>
                      {task.title}
                    </a>
                    <Status status={task.status} />
                    <div class="task-meta">
                      <span>{WORKFLOW[task.workflow].short}</span>
                      <span>
                        {task.resultOwner === teammate.id ? 'Result owner' : 'Specialist'}
                      </span>
                      <span>Updated {when(task.updatedAt)}</span>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </section>
        </div>
        <aside class="task-aside" aria-label="Teammate settings">
          <section class="card panel" aria-labelledby="cap-h">
            <div class="panel-head">
              <h2 id="cap-h">Capabilities here</h2>
            </div>
            <div class="panel-body stack-sm">
              <p class="subtle">
                What this teammate can actually do in {ctx.segment.name}: its request, intersected
                with segment policy, your membership and your connections.
              </p>
              <table class="calc-table">
                <thead>
                  <tr>
                    <th scope="col">Capability</th>
                    <th scope="col">Status</th>
                  </tr>
                </thead>
                <tbody>
                  {teammate.capabilities
                    .filter((state) => state.requested)
                    .map((state) => (
                      <tr>
                        <td>{CAPABILITY[state.capability]}</td>
                        <td>
                          {state.effective ? (
                            <span class="state-ready">Available</span>
                          ) : (
                            <span class="state-warn">{state.reason}</span>
                          )}
                        </td>
                      </tr>
                    ))}
                </tbody>
              </table>
            </div>
          </section>
          <section class="card panel" aria-labelledby="skills-h">
            <div class="panel-head">
              <h2 id="skills-h">Skills</h2>
            </div>
            <div class="panel-body stack-sm">
              {teammate.skills.length === 0 ? <p class="muted">No skills attached.</p> : null}
              {teammate.skills.map((skill) => (
                <form
                  class="row"
                  method="post"
                  action={segPath(ctx.segment, `/teammates/${teammate.id}/skills`)}
                >
                  <Csrf session={ctx.session} />
                  <input type="hidden" name="skillId" value={skill.id} />
                  <input type="hidden" name="version" value={String(skill.version)} />
                  <input type="hidden" name="attach" value="0" />
                  <a href={segPath(ctx.segment, `/catalog/skills/${skill.id}`)}>
                    {skill.name} v{skill.version}
                  </a>
                  <SubmitButton label="Detach" kind="btn-ghost" small />
                </form>
              ))}
              {available.length === 0 ? null : (
                <form
                  class="stack-sm"
                  method="post"
                  action={segPath(ctx.segment, `/teammates/${teammate.id}/skills`)}
                >
                  <Csrf session={ctx.session} />
                  <input type="hidden" name="attach" value="1" />
                  <div class="field">
                    <label for="attach-skill">Attach a skill</label>
                    <select id="attach-skill" name="skillRef" required>
                      {available.map((skill) => (
                        <option value={`${skill.id}:${skill.version}`}>
                          {skill.definition.name} v{skill.version}
                          {skill.origin === 'curated' ? '' : ` (${skill.origin})`}
                        </option>
                      ))}
                    </select>
                  </div>
                  <SubmitButton label="Attach" kind="btn" small />
                </form>
              )}
            </div>
          </section>
          <section class="card panel" aria-labelledby="edit-h">
            <div class="panel-head">
              <h2 id="edit-h">Customize</h2>
              <span class="subtle">version {teammate.version}</span>
            </div>
            <form
              class="panel-body form-grid"
              method="post"
              action={segPath(ctx.segment, `/teammates/${teammate.id}`)}
              data-draft={`tm-${teammate.id}`}
            >
              <Csrf session={ctx.session} />
              <input type="hidden" name="expectedVersion" value={String(teammate.version)} />
              <div class="field">
                <label for="tm-name">Name</label>
                <input id="tm-name" name="name" value={teammate.name} required maxlength="80" />
              </div>
              <div class="field">
                <label for="tm-role">Role</label>
                <input id="tm-role" name="role" value={teammate.role} required maxlength="160" />
              </div>
              <div class="field">
                <label for="tm-ins">Instructions</label>
                <textarea id="tm-ins" name="instructions" required maxlength="4000">
                  {teammate.instructions}
                </textarea>
                <p class="hint">
                  Changes apply to new work only. Running and finished tasks keep the version they
                  started with. The curated template does not change.
                </p>
              </div>
              <SubmitButton label="Save changes" kind="btn" />
            </form>
          </section>
        </aside>
      </div>
    </Shell>
  );
}

export function CatalogPage(props: {
  readonly ctx: PageCtx;
  readonly templates: readonly TemplateView[];
  readonly skills: readonly SkillView[];
}): Html {
  const { ctx } = props;
  return (
    <Shell ctx={ctx} title="Catalog">
      <PageHead
        title="Catalog"
        lead={`Templates and skills curated by administrators for ${ctx.segment.name}, plus your private copies. Copies never change the originals.`}
      />
      <section aria-labelledby="tpl-h">
        <h2 class="section-title" id="tpl-h">
          Teammate templates
        </h2>
        <div class="cards">
          {props.templates.map((template) => (
            <article class="card tm-card">
              <div>
                <h3>{template.definition.name}</h3>
                <p class="muted">{template.definition.role}</p>
              </div>
              <div class="chips">
                {template.definition.capabilityRequests.map((capability) => (
                  <span class="chip">{capabilityLabel(capability)}</span>
                ))}
              </div>
              <p class="subtle">Curated · version {template.version}</p>
              <form class="row" method="post" action={segPath(ctx.segment, TEAMMATES_PATH)}>
                <Csrf session={ctx.session} />
                <input type="hidden" name="templateId" value={template.id} />
                <input type="hidden" name="clientRequestId" value={crypto.randomUUID()} />
                <span class="field">
                  <label class="sr-only" for={`n-${template.id}`}>
                    Name for your copy of {template.definition.name}
                  </label>
                  <input
                    id={`n-${template.id}`}
                    name="name"
                    placeholder={`Name (default: ${template.definition.name})`}
                    maxlength="80"
                  />
                </span>
                <SubmitButton label="Add to my team" kind="btn" small />
              </form>
            </article>
          ))}
        </div>
      </section>
      <section aria-labelledby="sk-h" class="footer-note">
        <h2 class="section-title" id="sk-h">
          Skills
        </h2>
        <div class="cards">
          {props.skills.map((skill) => (
            <article class="card tm-card">
              <div>
                <h3>
                  <a href={segPath(ctx.segment, `/catalog/skills/${skill.id}`)}>
                    {skill.definition.name}
                  </a>
                </h3>
                <p class="muted">{skill.definition.summary}</p>
              </div>
              <div class="chips">
                {skill.definition.workflows.map((workflow) => (
                  <span class="chip">{workflowInfo(workflow).short}</span>
                ))}
                {skill.definition.capabilities.map((capability) => (
                  <span class="chip">{capabilityLabel(capability)}</span>
                ))}
              </div>
              <p class="subtle">
                {skill.origin === 'curated'
                  ? 'Curated'
                  : skill.origin === 'private'
                    ? 'Your private copy'
                    : 'Imported'}{' '}
                · version {skill.version} · attached to {skill.attachedTo.length} teammate
                {skill.attachedTo.length === 1 ? '' : 's'}
              </p>
            </article>
          ))}
        </div>
      </section>
    </Shell>
  );
}

export function SkillPage(props: {
  readonly ctx: PageCtx;
  readonly versions: readonly SkillView[];
  readonly teammates: readonly TeammateView[];
}): Html {
  const { ctx, versions } = props;
  const latest = versions.at(-1) as SkillView;
  const d = latest.definition;
  const attachedTo = new Set(
    props.teammates.filter((t) => t.skills.some((s) => s.id === latest.id)).map((t) => t.id),
  );
  return (
    <Shell ctx={ctx} title={d.name}>
      <PageHead
        title={d.name}
        lead={d.summary}
        crumbs={[{ label: 'Catalog', href: segPath(ctx.segment, '/catalog') }]}
      />
      <div class="task-layout">
        <div class="stack">
          <section class="card card-body stack-sm" aria-labelledby="def-h">
            <h2 id="def-h">Procedure (version {latest.version})</h2>
            <dl class="kv">
              <dt>Origin</dt>
              <dd>
                {latest.origin === 'curated'
                  ? 'Curated by administrators'
                  : latest.origin === 'private'
                    ? `Your private copy${latest.derivedFrom === null ? '' : ` of a curated skill (version ${latest.derivedFrom.version})`}`
                    : 'Imported'}
              </dd>
              <dt>Applies to</dt>
              <dd>{d.applicability}</dd>
              <dt>Inputs</dt>
              <dd>
                {d.inputs.length === 0
                  ? 'None'
                  : d.inputs
                      .map(
                        (input) =>
                          `${input.name}${input.required ? ' (required)' : ''}: ${input.description}`,
                      )
                      .join('; ')}
              </dd>
              <dt>Output sections</dt>
              <dd>{d.outputSections.join(', ')}</dd>
              <dt>Missing data</dt>
              <dd>{d.missingData}</dd>
              <dt>Approval boundary</dt>
              <dd>{d.approvalBoundary}</dd>
              <dt>Capabilities</dt>
              <dd>{d.capabilities.map(capabilityLabel).join(', ') || 'None'}</dd>
            </dl>
            <h3>Steps</h3>
            <ol>
              {d.steps.map((step) => (
                <li>{step}</li>
              ))}
            </ol>
            <h3>Validation</h3>
            <ul>
              {d.validation.map((rule) => (
                <li>{rule}</li>
              ))}
            </ul>
          </section>
          <section class="card" aria-labelledby="ver-h">
            <div class="panel-head">
              <h2 id="ver-h">Versions</h2>
            </div>
            <ul class="task-list">
              {versions.map((version) => (
                <li class="task-item">
                  <span class="task-title">Version {version.version}</span>
                  <span class="subtle">{when(version.createdAt)}</span>
                </li>
              ))}
            </ul>
          </section>
        </div>
        <aside class="task-aside">
          <section class="card panel" aria-labelledby="att-h">
            <div class="panel-head">
              <h2 id="att-h">Attach to teammates</h2>
            </div>
            <form
              class="panel-body stack-sm"
              method="post"
              action={segPath(ctx.segment, `/catalog/skills/${latest.id}/attach`)}
            >
              <Csrf session={ctx.session} />
              <input type="hidden" name="version" value={String(latest.version)} />
              <fieldset class="field">
                <legend>Teammates using version {latest.version}</legend>
                <div class="stack-sm">
                  {props.teammates.map((teammate) => (
                    <label class="choice">
                      <input
                        type="checkbox"
                        name="teammate"
                        value={teammate.id}
                        checked={attachedTo.has(teammate.id)}
                      />
                      <span>
                        {teammate.name}
                        <span class="subtle"> · {teammate.role}</span>
                      </span>
                    </label>
                  ))}
                </div>
              </fieldset>
              <SubmitButton label="Save attachments" kind="btn" />
            </form>
          </section>
          <section class="card panel" aria-labelledby="cust-h">
            <div class="panel-head">
              <h2 id="cust-h">
                {latest.origin === 'curated' ? 'Make a private copy' : 'Edit (new version)'}
              </h2>
            </div>
            <form
              class="panel-body form-grid"
              method="post"
              action={segPath(ctx.segment, `/catalog/skills/${latest.id}/customize`)}
              data-draft={`skill-${latest.id}`}
            >
              <Csrf session={ctx.session} />
              <input type="hidden" name="fromVersion" value={String(latest.version)} />
              <div class="field">
                <label for="sk-name">Name</label>
                <input
                  id="sk-name"
                  name="name"
                  value={latest.origin === 'curated' ? `${d.name} (my copy)` : d.name}
                  required
                  maxlength="80"
                />
              </div>
              <div class="field">
                <label for="sk-summary">Summary</label>
                <textarea id="sk-summary" name="summary" required maxlength="300">
                  {d.summary}
                </textarea>
              </div>
              <div class="field">
                <label for="sk-steps">Steps (one per line)</label>
                <textarea id="sk-steps" name="steps" required>
                  {d.steps.join('\n')}
                </textarea>
              </div>
              <div class="field">
                <label for="sk-validation">Validation rules (one per line)</label>
                <textarea id="sk-validation" name="validation">
                  {d.validation.join('\n')}
                </textarea>
              </div>
              <div class="field">
                <label for="sk-missing">When data is missing</label>
                <textarea id="sk-missing" name="missingData" required maxlength="400">
                  {d.missingData}
                </textarea>
              </div>
              <p class="hint">
                {latest.origin === 'curated'
                  ? 'Creates your own skill. The curated original and other members’ copies stay as they are.'
                  : 'Saves a new version. Teammates keep the version they use until you attach the new one.'}
              </p>
              <SubmitButton
                label={latest.origin === 'curated' ? 'Create private copy' : 'Save new version'}
                kind="btn"
              />
            </form>
          </section>
        </aside>
      </div>
    </Shell>
  );
}

const PROVIDERS: Record<Connection['provider'], { title: string; uses: string }> = {
  google: {
    title: 'Google (Drive, Docs, BigQuery)',
    uses: 'Reads the segment research and context folders, runs approved read-only BigQuery queries, and creates Google Docs only after you approve the exact content.',
  },
  github: {
    title: 'GitHub (read-only)',
    uses: 'Reads issues and code in the repositories this segment allows. It never writes.',
  },
};

function ConnectionBadge(props: { readonly connection: Connection }): Html {
  const { connection } = props;
  const tone =
    connection.status === 'active'
      ? 'badge-ok'
      : connection.status === 'not_connected'
        ? 'badge-neutral'
        : 'badge-bad';
  const label =
    connection.status === 'active'
      ? 'Connected'
      : connection.status === 'not_connected'
        ? 'Not connected'
        : `Needs attention (${connection.errorCode ?? connection.status})`;
  return <span class={`badge ${tone}`}>{label}</span>;
}

function ConnectionActions(props: {
  readonly ctx: PageCtx;
  readonly connection: Connection;
}): Html {
  const { ctx, connection } = props;
  if (!connection.configured)
    return (
      <Alert tone="warn" live={false}>
        <p>This provider is not configured yet. See docs/m1/SETUP_OAUTH.md.</p>
      </Alert>
    );
  return (
    <div class="row">
      <form
        method="post"
        action={segPath(ctx.segment, `/connections/${connection.provider}/start`)}
      >
        <Csrf session={ctx.session} />
        <SubmitButton
          label={connection.status === 'not_connected' ? 'Connect' : 'Reconnect'}
          kind={connection.status === 'active' ? 'btn' : 'btn-primary'}
        />
      </form>
      {connection.status === 'not_connected' ? null : (
        <form
          method="post"
          action={segPath(ctx.segment, `/connections/${connection.provider}/disconnect`)}
        >
          <Csrf session={ctx.session} />
          <SubmitButton label="Disconnect" kind="btn-danger" />
        </form>
      )}
    </div>
  );
}

function ConnectionCard(props: { readonly ctx: PageCtx; readonly connection: Connection }): Html {
  const { ctx, connection } = props;
  const describe = PROVIDERS[connection.provider];
  return (
    <section class="card card-body stack-sm" aria-labelledby={`c-${connection.provider}`}>
      <div class="row">
        <h2 id={`c-${connection.provider}`}>{describe.title}</h2>
        <ConnectionBadge connection={connection} />
      </div>
      <p class="muted">{describe.uses}</p>
      {connection.account === null ? null : (
        <dl class="kv">
          <dt>Account</dt>
          <dd>{connection.account}</dd>
          <dt>Connected</dt>
          <dd>{when(connection.connectedAt)}</dd>
          <dt>Scopes</dt>
          <dd>
            {connection.scopes.length === 0
              ? 'None (public read only)'
              : connection.scopes
                  .map((s) => s.replace('https://www.googleapis.com/auth/', ''))
                  .join(', ')}
          </dd>
        </dl>
      )}
      <ConnectionActions ctx={ctx} connection={connection} />
    </section>
  );
}

function ModelCard(props: { readonly r: Readiness }): Html {
  const { r } = props;
  return (
    <section class="card card-body stack-sm" aria-labelledby="c-model">
      <div class="row">
        <h2 id="c-model">Model (Vertex AI)</h2>
        <span
          class={`badge ${r.model.state === 'error' ? 'badge-bad' : r.model.state === 'ready' ? 'badge-ok' : 'badge-neutral'}`}
        >
          {r.model.state === 'ready'
            ? 'Ready'
            : r.model.state === 'unverified'
              ? 'Not used yet'
              : 'Error'}
        </span>
      </div>
      <p class="muted">
        The segment calls {r.model.modelId} with the operator's model credential. That credential
        proves nothing about you and never reads your sources.
      </p>
      <dl class="kv">
        <dt>Model</dt>
        <dd>{r.model.modelId}</dd>
        <dt>Calls used</dt>
        <dd>
          {r.model.callsUsed} of {r.model.callsLimit} (concurrency {r.model.concurrency})
        </dd>
        <dt>Last call</dt>
        <dd>
          {r.model.lastCall === null
            ? 'None'
            : `${r.model.lastCall.outcome}, ${when(r.model.lastCall.at)}${r.model.lastCall.modelVersion === null ? '' : `, ${r.model.lastCall.modelVersion}`}`}
        </dd>
      </dl>
      {r.model.remediation === null ? null : (
        <Alert tone="danger" title={r.model.errorCode ?? 'Model error'}>
          <p>{r.model.remediation}</p>
        </Alert>
      )}
    </section>
  );
}

export function ConnectionsPage(props: {
  readonly ctx: PageCtx;
  readonly connections: readonly Connection[];
}): Html {
  const { ctx } = props;
  return (
    <Shell ctx={ctx} title="Connections">
      <PageHead
        title="Connections"
        lead={`Your own accounts, connected to ${ctx.segment.name} only. Another segment has separate connections, and nobody else can use yours.`}
      />
      <div class="grid-2">
        {props.connections.map((connection) => (
          <ConnectionCard ctx={ctx} connection={connection} />
        ))}
        {ctx.readiness === undefined ? null : <ModelCard r={ctx.readiness} />}
      </div>
    </Shell>
  );
}

export function ExportPage(props: {
  readonly ctx: PageCtx;
  readonly teammate: TeammateView;
  readonly preview: ExportPreview;
}): Html {
  const { ctx, teammate, preview } = props;
  const blocked = preview.findings.length > 0;
  return (
    <Shell ctx={ctx} title="Export definition">
      <PageHead
        title={`Export ${teammate.name}`}
        lead="A portable definition: role, instructions, skills and requested capabilities. It never contains your connections, credentials, conversations, tasks, sources or results."
        crumbs={[
          { label: 'Teammates', href: segPath(ctx.segment, TEAMMATES_PATH) },
          { label: teammate.name, href: segPath(ctx.segment, `/teammates/${teammate.id}`) },
        ]}
      />
      {blocked ? (
        <Alert tone="danger" title="Remove private details before exporting">
          <ul>
            {preview.findings.map((finding) => (
              <li>
                {finding.label} in <code>{finding.field}</code>
              </li>
            ))}
          </ul>
          <p>
            Edit the teammate or skill text, then come back. Automatic checks catch known secret
            shapes and your own identifiers, not every private fact written in prose, so read the
            preview too.
          </p>
        </Alert>
      ) : (
        <Alert tone="info" title="Check the preview">
          <p>
            Automatic checks found no credentials or private identifiers. They cannot recognize
            every private fact written in prose, so read the text below before sharing it.
          </p>
        </Alert>
      )}
      <section class="card card-body stack-sm footer-note">
        <h2>Definition preview</h2>
        <pre class="code-block">{preview.json}</pre>
        <div class="row">
          {blocked ? null : (
            <a
              class="btn btn-primary"
              href={segPath(ctx.segment, `/teammates/${teammate.id}/export.json`)}
              download={`${teammate.name.replaceAll(/[^A-Za-z0-9-]+/g, '-')}.json`}
            >
              <Icon name="download" small />
              Download definition
            </a>
          )}
          <button class="btn" type="button" data-copy={preview.json}>
            <Icon name="copy" small />
            Copy
          </button>
        </div>
      </section>
    </Shell>
  );
}

export function ImportPage(props: {
  readonly ctx: PageCtx;
  readonly draft?: string;
  readonly result?: {
    readonly teammate: TeammateView;
    readonly capabilities: readonly CapabilityState[];
  };
}): Html {
  const { ctx } = props;
  return (
    <Shell ctx={ctx} title="Import definition">
      <PageHead
        title="Import a teammate definition"
        lead="Creates a new teammate owned by you. It uses your own connections in this segment; it can never carry someone else's access."
        crumbs={[{ label: 'Teammates', href: segPath(ctx.segment, TEAMMATES_PATH) }]}
      />
      {props.result === undefined ? null : (
        <Alert tone="ok" title={`Imported ${props.result.teammate.name}`}>
          <p>
            Requested capabilities are only requests. Here is what this segment, your membership and
            your connections allow:
          </p>
          <CapabilityChips states={props.result.capabilities} requestedOnly />
          <p class="actions">
            <a
              class="btn btn-sm"
              href={segPath(ctx.segment, `/teammates/${props.result.teammate.id}`)}
            >
              Open teammate
            </a>
          </p>
        </Alert>
      )}
      <form
        class="card card-body form-grid footer-note"
        method="post"
        action={segPath(ctx.segment, '/import')}
        data-draft="import"
      >
        <Csrf session={ctx.session} />
        <input type="hidden" name="clientRequestId" value={crypto.randomUUID()} />
        <div class="field">
          <label for="def">Definition (JSON)</label>
          <textarea id="def" name="definition" required rows="14" class="mono">
            {props.draft ?? ''}
          </textarea>
          <p class="hint">
            Files with unknown fields, such as connections or tokens, are rejected whole. So is text
            that looks like a credential.
          </p>
        </div>
        <SubmitButton label="Import" />
      </form>
    </Shell>
  );
}

export function SignInPage(props: {
  readonly identity: 'google' | 'local-test';
  readonly error?: string;
  readonly configured: boolean;
  readonly csrf: string;
}): Html {
  return (
    <main class="signin" id="main">
      <div class="card">
        <div class="card-body">
          <div class="row">
            <span class="brand-mark" aria-hidden="true">
              AW
            </span>
            <h1>Agent Works</h1>
          </div>
          <p class="muted">
            Personal AI teammates for your segments. Sign in with your work Google account.
          </p>
          {props.error === undefined ? null : (
            <Alert tone="danger" title="Sign-in did not complete">
              <p>{signInText(props.error)}</p>
            </Alert>
          )}
          {props.identity === 'google' ? (
            props.configured ? (
              <a class="btn btn-primary provider-btn" href="/auth/google/start">
                Sign in with Google
              </a>
            ) : (
              <Alert tone="warn" title="Sign-in is not configured">
                <p>The Google OAuth client is missing. See docs/m1/SETUP_OAUTH.md.</p>
              </Alert>
            )
          ) : (
            <form class="stack-sm" method="post" action="/auth/local-test">
              <input type="hidden" name="csrf" value={props.csrf} />
              <Alert tone="warn" title="Local test identities">
                <p>
                  This stack runs in local-test mode. These identities are not real sign-ins and
                  cannot satisfy a live gate.
                </p>
              </Alert>
              <button class="btn provider-btn" type="submit" name="email" value="alice@local.test">
                Continue as alice@local.test
              </button>
              <button class="btn provider-btn" type="submit" name="email" value="bob@local.test">
                Continue as bob@local.test
              </button>
            </form>
          )}
          <p class="subtle">
            Sign-in proves who you are. Access to Drive, BigQuery and GitHub is connected separately
            in each segment.
          </p>
        </div>
      </div>
    </main>
  );
}

function signInText(code: string): string {
  const map: Record<string, string> = {
    not_a_member:
      'Your Google account is not a member of any segment here. Ask the operator to add it.',
    bad_state: 'The sign-in attempt expired or was already used. Start again.',
    email_unverified: 'Google did not confirm the email address of that account.',
    exchange_failed: 'Google did not complete the sign-in. Try again.',
    access_denied: 'You cancelled the sign-in at Google.',
  };
  return Object.hasOwn(map, code)
    ? // eslint-disable-next-line security/detect-object-injection
      (map[code] ?? code)
    : 'The sign-in could not be verified. Try again.';
}

export function ErrorPage(props: {
  readonly ctx: PageCtx | undefined;
  readonly title: string;
  readonly code: string;
}): Html {
  const body = (
    <div class="card card-body stack-sm">
      <h1>{props.title}</h1>
      <p class="muted">{errorText(props.code)}</p>
      <p>
        <a class="btn" href={props.ctx === undefined ? '/' : segPath(props.ctx.segment, '/inbox')}>
          Go to inbox
        </a>
      </p>
    </div>
  );
  return props.ctx === undefined ? (
    <main class="signin">{body}</main>
  ) : (
    <Shell ctx={props.ctx} title={props.title}>
      {body}
    </Shell>
  );
}

export function DocumentPage(props: {
  readonly ctx: PageCtx;
  readonly doc: { readonly title: string; readonly markdown: string; readonly createdAt: string };
}): Html {
  return (
    <Shell ctx={props.ctx} title={props.doc.title}>
      <PageHead
        title={props.doc.title}
        lead={`Fixture document store (not Google Docs), created ${when(props.doc.createdAt)}.`}
      />
      <pre class="code-block doc-page">{props.doc.markdown}</pre>
    </Shell>
  );
}
