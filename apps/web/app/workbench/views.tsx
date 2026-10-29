import { OBJECTIVE_MAX_LENGTH } from '@agent-works/domain/workbench';

import { Fragment, h } from '../html.js';

import { Icon } from './icons.js';

import type { FixtureDocument, FixtureSource } from './api.js';
import type { IconName } from './icons.js';
import type { Child, Html } from '../html.js';
import type {
  WorkbenchReadiness,
  WorkbenchStatus,
  WorkbenchTaskSummary,
} from '@agent-works/domain/workbench';

export const FLAGSHIP_PROMPT =
  'Review the October incident reports in my authorized Google Drive, identify recurring causes with citations, and draft a summary Google Doc for my approval.';

export type NavKey = 'home' | 'tasks' | 'approvals' | 'connections' | 'none';

export type ShellProps = {
  readonly title: string;
  readonly active: NavKey;
  readonly readiness: WorkbenchReadiness | undefined;
  readonly pendingApprovals: number;
  readonly body: Html;
};

const statusView: Record<WorkbenchStatus, { readonly label: string; readonly tone: string }> = {
  queued: { label: 'Queued', tone: 'active' },
  running: { label: 'Running', tone: 'active' },
  waiting_approval: { label: 'Needs approval', tone: 'wait' },
  executing: { label: 'Writing document', tone: 'active' },
  completed: { label: 'Completed', tone: 'ok' },
  declined: { label: 'Write rejected', tone: 'neutral' },
  failed: { label: 'Failed', tone: 'bad' },
  cancel_requested: { label: 'Cancelling', tone: 'active' },
  cancelled: { label: 'Cancelled', tone: 'neutral' },
  outcome_uncertain: { label: 'Outcome uncertain', tone: 'wait' },
};

export const liveStatuses: readonly WorkbenchStatus[] = [
  'queued',
  'running',
  'executing',
  'cancel_requested',
];

export function StatusPill(status: WorkbenchStatus): Html {
  // eslint-disable-next-line security/detect-object-injection
  const view = statusView[status];
  return h('span', { class: `status status-${view.tone}`, 'data-status': status }, view.label);
}

export function statusLabel(status: WorkbenchStatus): string {
  // eslint-disable-next-line security/detect-object-injection
  return statusView[status].label;
}

export function Time(iso: string, withDate = true): Html {
  const date = new Date(iso);
  const text = withDate
    ? `${date.toLocaleString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' })}, ${clock(date)} UTC`
    : `${clock(date)} UTC`;
  return h('time', { datetime: iso, 'data-local': withDate ? 'datetime' : 'time' }, text);
}

function clock(date: Date): string {
  return date.toISOString().slice(11, 19);
}

export function duration(ms: number | null): string {
  if (ms === null) return '';
  return ms < 1000 ? `${ms} ms` : `${(ms / 1000).toFixed(1)} s`;
}

/** The one place the Vertex label is spelled; the stub label differs per surface. */
export function modelLabel(mode: 'vertex' | 'stub', modelId: string, stub: string): string {
  return mode === 'stub' ? stub : `Vertex AI · ${modelId}`;
}

function ModelBadge(readiness: WorkbenchReadiness | undefined, hideSmall = false): Html | null {
  if (readiness === undefined) return null;
  const { model } = readiness;
  if (model.mode === 'stub')
    return h(
      'span',
      { class: 'badge badge-stub', title: 'Offline stub model: not a real LLM' },
      'STUB MODEL (offline test mode)',
    );
  return h(
    'span',
    { class: `badge badge-model${hideSmall ? ' badge-hide-sm' : ''}` },
    Icon({ name: 'sparkle', small: true }),
    `Vertex AI · ${model.modelId}`,
  );
}

export function SimBadge(text = 'Simulated Workspace'): Html {
  return h(
    'span',
    { class: 'badge badge-sim', title: 'Fixture adapter: no real Google Drive or Docs access' },
    text,
  );
}

function NavLink(
  href: string,
  icon: IconName,
  label: string,
  active: boolean,
  count?: number,
): Html {
  return h(
    'li',
    null,
    h(
      'a',
      { class: 'nav-link', href, 'aria-current': active ? 'page' : undefined },
      Icon({ name: icon }),
      h('span', null, label),
      count !== undefined && count > 0
        ? h('span', { class: 'nav-count', 'aria-label': `${count} pending` }, String(count))
        : null,
    ),
  );
}

export function Shell(props: ShellProps): Html {
  const identity = props.readiness?.identity;
  const who = identity?.email ?? identity?.sub ?? 'Signed in';
  return (
    <div class="shell">
      <a class="skip-link" href="#main">
        Skip to main content
      </a>
      <header class="topbar">
        <button
          class="btn btn-ghost btn-sm menu-button"
          type="button"
          aria-controls="sidenav"
          aria-expanded="false"
          data-menu-toggle="true"
        >
          {Icon({ name: 'menu' })}
          <span class="sr-only">Open navigation</span>
        </button>
        <a class="brand" href="/">
          <span class="brand-mark" aria-hidden="true">
            AW
          </span>
          <span>Agent Works</span>
        </a>
        <div class="env-badges">
          {SimBadge()}
          {ModelBadge(props.readiness, true)}
        </div>
        <span class="topbar-spacer"></span>
        <div class="user-chip">
          <span class="avatar" aria-hidden="true">
            {who.slice(0, 1)}
          </span>
          <span class="user-email">{who}</span>
          <a
            class="btn btn-ghost btn-sm"
            href="/_auth/sign-out"
            title="Sign out of the local test identity"
          >
            {Icon({ name: 'logout', small: true })}
            <span class="sr-only">Sign out</span>
          </a>
        </div>
      </header>
      <nav class="sidenav" id="sidenav" aria-label="Primary" data-open="false">
        <ul>
          {NavLink('/', 'plus', 'New task', props.active === 'home')}
          {NavLink('/tasks', 'list', 'Tasks', props.active === 'tasks')}
          {NavLink(
            '/approvals',
            'inbox',
            'Approvals',
            props.active === 'approvals',
            props.pendingApprovals,
          )}
          {NavLink('/connections', 'plug', 'Connections', props.active === 'connections')}
        </ul>
        <div class="nav-group">
          <p class="nav-label" id="admin-nav">
            Administration
          </p>
          <ul aria-labelledby="admin-nav">
            {NavLink('/schedules', 'calendar', 'Schedules', false)}
            {NavLink('/admin', 'settings', 'Admin', false)}
          </ul>
        </div>
      </nav>
      <main class="main" id="main" tabindex="-1">
        {props.body}
        <p class="footer-note">
          Local workbench. Identity comes from a local-only test proxy. Google Drive and Docs are a
          simulated fixture, so no real Workspace data is read or written.
        </p>
      </main>
      <div class="sr-only" id="announcer" role="status" aria-live="polite" aria-atomic="true"></div>
    </div>
  );
}

export function Breadcrumbs(
  items: readonly { readonly label: string; readonly href?: string }[],
): Html {
  return (
    <nav class="breadcrumbs" aria-label="Breadcrumb">
      <ol>
        {items.map((item, index) =>
          item.href !== undefined && index < items.length - 1 ? (
            <li>
              <a href={item.href}>{item.label}</a>
            </li>
          ) : (
            <li aria-current="page">{item.label}</li>
          ),
        )}
      </ol>
    </nav>
  );
}

function ReadinessAlert(readiness: WorkbenchReadiness | undefined): Html | null {
  if (readiness === undefined)
    return Alert(
      'danger',
      'The workbench API is unavailable',
      ['Tasks cannot be started right now. Check that the api service is healthy, then reload.'],
      undefined,
      'alert',
    );
  const { model } = readiness;
  if (model.state === 'ready' || model.state === 'unverified') return null;
  return Alert(
    model.state === 'not_configured' ? 'warn' : 'danger',
    model.state === 'not_configured' ? 'Vertex AI is not configured' : 'Vertex AI needs attention',
    [model.remediation ?? 'Open Connections for details.'],
    <a href="/connections">Open Connections</a>,
    'alert',
  );
}

type AlertTone = 'info' | 'warn' | 'danger' | 'ok' | 'sim';

const toneIcon: Record<AlertTone, IconName> = {
  info: 'info',
  sim: 'info',
  warn: 'alert',
  danger: 'alert',
  ok: 'check',
};

export function Alert(
  tone: AlertTone,
  title: string,
  lines: readonly Child[],
  actions?: Child,
  role?: 'alert' | 'status',
): Html {
  return h(
    'div',
    { class: `alert alert-${tone}`, role },
    // eslint-disable-next-line security/detect-object-injection
    Icon({ name: toneIcon[tone] }),
    h(
      'div',
      null,
      h('h2', null, title),
      ...lines.map((line) => h('p', null, line)),
      actions === undefined ? null : h('div', { class: 'actions row' }, actions),
    ),
  );
}

export type HomeView = {
  readonly csrf: string;
  readonly clientRequestId: string;
  readonly readiness: WorkbenchReadiness | undefined;
  readonly recent: readonly WorkbenchTaskSummary[];
  readonly draft: string;
  readonly error?: string;
};

export function HomePage(view: HomeView): Html {
  const blocked = view.readiness === undefined || view.readiness.model.state === 'not_configured';
  return (
    <>
      <div class="page-head">
        <div>
          <h1>New task</h1>
          <p>
            Describe the outcome you need. The agent retrieves evidence, drafts, and asks before it
            writes anything.
          </p>
        </div>
      </div>
      <div class="stack">
        {ReadinessAlert(view.readiness)}
        <form class="card composer" method="post" action="/tasks" data-composer="true" novalidate>
          <input type="hidden" name="csrf" value={view.csrf} />
          <input type="hidden" name="clientRequestId" value={view.clientRequestId} />
          <label for="objective">Objective</label>
          <textarea
            id="objective"
            name="objective"
            maxlength={OBJECTIVE_MAX_LENGTH}
            required
            aria-describedby={
              view.error === undefined ? 'objective-hint' : 'objective-hint objective-error'
            }
            aria-invalid={view.error === undefined ? undefined : 'true'}
            placeholder="For example: review last month's incident reports and draft a summary for my approval."
          >
            {view.draft}
          </textarea>
          {view.error === undefined ? null : (
            <p class="field-error" id="objective-error" role="alert">
              {view.error}
            </p>
          )}
          <div class="composer-foot">
            <p class="subtle" id="objective-hint">
              Press <kbd class="kbd">Ctrl</kbd> + <kbd class="kbd">Enter</kbd> (
              <kbd class="kbd">⌘</kbd> + <kbd class="kbd">Enter</kbd> on Mac) to start.{' '}
              <kbd class="kbd">Enter</kbd> adds a new line.{' '}
              <span data-counter="true" aria-live="off"></span>
            </p>
            <button class="btn btn-primary" type="submit" disabled={blocked} data-submit="true">
              <span class="spinner" aria-hidden="true"></span>
              <span data-label="true">Start task</span>
            </button>
          </div>
          <div class="suggestions" aria-label="Example prompt">
            <a class="suggestion" href="/?prompt=flagship" data-fill={FLAGSHIP_PROMPT}>
              <strong>Try:</strong> {FLAGSHIP_PROMPT}
            </a>
          </div>
        </form>
        <section class="card" aria-labelledby="recent-heading">
          <div class="panel-head">
            <h2 id="recent-heading">Recent tasks</h2>
            <a class="btn btn-ghost btn-sm" href="/tasks">
              View all
            </a>
          </div>
          {view.recent.length === 0
            ? EmptyState(
                'list',
                'No tasks yet',
                'Tasks you start appear here and stay after refresh or restart.',
              )
            : TaskListItems(view.recent.slice(0, 5))}
        </section>
      </div>
    </>
  );
}

function EmptyState(icon: IconName, title: string, text: string, action?: Html): Html {
  return (
    <div class="empty">
      {Icon({ name: icon })}
      <h2>{title}</h2>
      <p class="muted">{text}</p>
      {action === undefined ? null : <div class="actions">{action}</div>}
    </div>
  );
}

function TaskListItems(tasks: readonly WorkbenchTaskSummary[]): Html {
  return (
    <ul class="task-list">
      {tasks.map((task) => (
        <li class="task-item">
          <a class="task-title" href={`/tasks/${task.id}`}>
            {task.title}
          </a>
          {StatusPill(task.status)}
          <div class="task-meta">
            <span>Created {Time(task.createdAt)}</span>
            <span>Updated {Time(task.updatedAt)}</span>
            <span>{modelLabel(task.llmMode, task.modelId, 'Stub model')}</span>
          </div>
        </li>
      ))}
    </ul>
  );
}

export function TasksPage(tasks: readonly WorkbenchTaskSummary[]): Html {
  return (
    <>
      <div class="page-head">
        <div>
          <h1>Tasks</h1>
          <p>Your tasks only. Other people cannot see them, and you cannot see theirs.</p>
        </div>
        <a class="btn btn-primary" href="/">
          {Icon({ name: 'plus' })} New task
        </a>
      </div>
      <section class="card" aria-label="Task history">
        {tasks.length === 0
          ? EmptyState(
              'list',
              'No tasks yet',
              'Start a task to see its status, evidence, and approvals here.',
              <a class="btn btn-primary" href="/">
                Start a task
              </a>,
            )
          : TaskListItems(tasks)}
      </section>
    </>
  );
}

export function ApprovalsPage(tasks: readonly WorkbenchTaskSummary[]): Html {
  const pending = tasks.filter((task) => task.status === 'waiting_approval');
  return (
    <>
      <div class="page-head">
        <div>
          <h1>Approvals</h1>
          <p>
            Actions waiting for your decision. Nothing is written until you approve it in the task.
          </p>
        </div>
      </div>
      <section class="card" aria-label="Pending approvals">
        {pending.length === 0
          ? EmptyState(
              'inbox',
              'No approvals waiting',
              'When a task proposes a write, it appears here.',
            )
          : TaskListItems(pending)}
      </section>
    </>
  );
}

const modelStateView: Record<
  WorkbenchReadiness['model']['state'],
  { readonly label: string; readonly tone: string }
> = {
  ready: { label: 'Ready', tone: 'state-ready' },
  unverified: { label: 'Configured, not yet verified by a call', tone: 'state-warn' },
  not_configured: { label: 'Not configured', tone: 'state-error' },
  error: { label: 'Error', tone: 'state-error' },
};

const credentialsText: Record<WorkbenchReadiness['model']['credentials'], string> = {
  present: 'Application Default Credentials mounted (read-only)',
  ambient: 'Ambient Application Default Credentials (gcloud well-known file or metadata server)',
  missing: 'Missing',
  not_required: 'Not required',
};

function LastCall(lastCall: WorkbenchReadiness['model']['lastCall']): Child {
  if (lastCall === null) return 'None yet';
  const latency = lastCall.latencyMs === null ? '' : ` · ${duration(lastCall.latencyMs)}`;
  return h(Fragment, null, Time(lastCall.at), ` · ${lastCall.outcome}${latency}`);
}

function ModelCard(model: WorkbenchReadiness['model']): Html {
  const state = modelStateView[model.state];
  const credentials = credentialsText[model.credentials];
  return (
    <section class="card" aria-labelledby="model-heading">
      <div class="card-body stack-sm">
        <div class="row">
          {Icon({ name: 'sparkle' })}
          <h2 id="model-heading">Model: {model.mode === 'stub' ? 'Offline stub' : 'Vertex AI'}</h2>
        </div>
        <p class={state.tone} data-model-state={model.state}>
          <strong>{state.label}</strong>
        </p>
        <dl class="kv">
          <dt>Mode</dt>
          <dd>
            {model.mode === 'stub' ? 'stub (opt-in, not a real model)' : 'vertex (real model)'}
          </dd>
          <dt>Model ID</dt>
          <dd class="mono" data-model-id="true">
            {model.modelId}
          </dd>
          <dt>Project</dt>
          <dd class="mono" data-redact="project">
            {model.project || 'not set'}
          </dd>
          <dt>Location</dt>
          <dd class="mono">{model.location || 'not set'}</dd>
          <dt>Credentials</dt>
          <dd>{credentials}</dd>
          <dt>Last call</dt>
          <dd>{LastCall(model.lastCall)}</dd>
          <dt>Call budget</dt>
          <dd>
            {model.callsUsed} of {model.callsLimit} real calls used
          </dd>
        </dl>
        {model.remediation === null
          ? null
          : Alert(model.state === 'error' ? 'danger' : 'warn', 'How to fix', [model.remediation])}
      </div>
    </section>
  );
}

export function ConnectionsPage(readiness: WorkbenchReadiness | undefined): Html {
  if (readiness === undefined)
    return (
      <>
        <div class="page-head">
          <h1>Connections</h1>
        </div>
        {ReadinessAlert(undefined)}
      </>
    );
  const { model, workspace, identity } = readiness;
  return (
    <>
      <div class="page-head">
        <div>
          <h1>Connections</h1>
          <p>
            What the workbench can reach, which mode it runs in, and how to fix problems. Tokens and
            credential paths are never shown.
          </p>
        </div>
      </div>
      <div class="grid-2">
        {ModelCard(model)}
        <section class="card" aria-labelledby="ws-heading">
          <div class="card-body stack-sm">
            <div class="row">
              {Icon({ name: 'file' })}
              <h2 id="ws-heading">Google Workspace</h2>
              {SimBadge('Simulated fixture')}
            </div>
            <p class="state-warn">
              <strong>Live integration pending</strong>
            </p>
            <dl class="kv">
              <dt>Adapter</dt>
              <dd>{workspace.adapter} (deterministic, synthetic data)</dd>
              <dt>Drive read</dt>
              <dd>{workspace.readScope}</dd>
              <dt>Docs write</dt>
              <dd>{workspace.writeScope}</dd>
            </dl>
            <p class="muted">{workspace.note}</p>
          </div>
        </section>
        <section class="card" aria-labelledby="id-heading">
          <div class="card-body stack-sm">
            <div class="row">
              {Icon({ name: 'shield' })}
              <h2 id="id-heading">Identity</h2>
            </div>
            <dl class="kv">
              <dt>Signed in as</dt>
              <dd>{identity.email ?? identity.sub}</dd>
              <dt>Provider</dt>
              <dd>
                {identity.localOnly ? 'Local test IAP (fake, local-only)' : 'Google Cloud IAP'}
              </dd>
            </dl>
            <p class="muted">
              The api trusts this identity only because its IAP issuer and key URL point at the
              local proxy. Production configuration points them at Google.
            </p>
          </div>
        </section>
      </div>
    </>
  );
}

export function SourcePage(source: FixtureSource): Html {
  return (
    <div class="doc-page stack">
      {Breadcrumbs([{ label: 'Simulated Drive' }, { label: source.title }])}
      {Alert('sim', 'Simulated Drive document', [
        'Synthetic fixture data shown for provenance. This is not a real Google Drive file.',
      ])}
      <article class="card">
        <div class="card-body stack-sm">
          <h1>{source.title}</h1>
          <p class="subtle">Modified {Time(source.modifiedAt)}</p>
          <p>{source.body}</p>
        </div>
      </article>
    </div>
  );
}

export function DocumentPage(doc: FixtureDocument): Html {
  return (
    <div class="doc-page stack">
      {Breadcrumbs([{ label: 'Simulated Google Docs' }, { label: doc.title }])}
      {Alert('sim', 'Simulated Google Doc', [
        'Created by the fixture Docs adapter after your approval. No real Google Workspace document exists.',
      ])}
      <article class="card">
        <div class="card-body stack">
          <h1>{doc.body.title}</h1>
          <p class="subtle">
            Created {Time(doc.createdAt)} · <span class="mono">{doc.docId}</span>
          </p>
          {doc.body.sections.map((section) => (
            <section class="stack-sm">
              <h2>{section.heading}</h2>
              {section.lines.length === 1 ? (
                <p>{section.lines[0]}</p>
              ) : (
                <ul>
                  {section.lines.map((line) => (
                    <li>{line}</li>
                  ))}
                </ul>
              )}
            </section>
          ))}
          <section class="stack-sm">
            <h2>Sources</h2>
            <ul>
              {doc.body.sources.map((source) => (
                <li>
                  {source.id}: {source.title}
                </li>
              ))}
            </ul>
          </section>
        </div>
      </article>
    </div>
  );
}

export function ErrorPage(title: string, text: string): Html {
  return (
    <section class="card">
      {EmptyState(
        'alert',
        title,
        text,
        <a class="btn btn-primary" href="/tasks">
          Go to tasks
        </a>,
      )}
    </section>
  );
}
