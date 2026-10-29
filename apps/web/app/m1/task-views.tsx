import { SOURCE_CAPABILITY } from '@agent-works/domain/teamwork';
import { safeWorkbenchUrl } from '@agent-works/domain/workbench';

import { Fragment, h } from '../html.js';
import { Icon } from '../workbench/icons.js';

import {
  ASSIGNMENT_STATUS,
  STATEMENT,
  TASK_STATUS,
  WORKFLOW,
  capabilityLabel,
  sourceLabel,
  when,
  workflowInfo,
} from './labels.js';
import {
  Alert,
  Csrf,
  NEW_TASK_PATH,
  PageHead,
  Shell,
  Status,
  SubmitButton,
  TEAMMATES_PATH,
  segPath,
} from './views.js';

import type { PageCtx } from './views.js';
import type { Html } from '../html.js';
import type {
  ActionApprovalView,
  AssignmentView,
  EvidenceView,
  PlanView,
  RevisionView,
  SourceKind,
  Statement,
  TaskDetail,
  TaskSummary,
  TeammateView,
  Workflow,
} from '@agent-works/domain/teamwork';

const WORKFLOW_SOURCES: Record<Workflow, readonly SourceKind[]> = {
  research_brief: ['drive_research'],
  metrics_explanation: ['bigquery_metrics', 'drive_context'],
  engineering_proposal: ['github_issue', 'github_code'],
};

function workflowSources(workflow: Workflow): readonly SourceKind[] {
  // eslint-disable-next-line security/detect-object-injection
  return WORKFLOW_SOURCES[workflow];
}

/** Links shown to members: https only, or this segment's own fixture document pages. */
function safeHref(url: string | null, segment: string): string | null {
  if (url === null) return null;
  if (url.startsWith('/fixtures/docs/'))
    return segPath(segment, `/fixture-docs/${url.slice('/fixtures/docs/'.length)}`);
  return url.startsWith('/') ? null : safeWorkbenchUrl(url);
}

export function TasksPage(props: {
  readonly ctx: PageCtx;
  readonly tasks: readonly TaskSummary[];
}): Html {
  const { ctx } = props;
  return (
    <Shell ctx={ctx} title="Tasks">
      <PageHead
        title="Tasks"
        lead="Everything you delegated in this segment, newest activity first."
      >
        <a class="btn btn-primary" href={segPath(ctx.segment, NEW_TASK_PATH)}>
          <Icon name="plus" small />
          New task
        </a>
      </PageHead>
      {props.tasks.length === 0 ? (
        <div class="card">
          <div class="empty">
            <Icon name="list" />
            <h2>No tasks yet</h2>
            <p class="muted">
              Pick a workflow, choose specialists or let the coordinator plan, and come back when
              the inbox says your result is ready.
            </p>
            <p>
              <a class="btn btn-primary" href={segPath(ctx.segment, NEW_TASK_PATH)}>
                Start a task
              </a>
            </p>
          </div>
        </div>
      ) : (
        <div class="card">
          <ul class="task-list">
            {props.tasks.map((task) => (
              <li class="task-item">
                <a class="task-title" href={segPath(ctx.segment, `/tasks/${task.id}`)}>
                  {task.title}
                </a>
                <Status status={task.status} />
                <div class="task-meta">
                  <span>{WORKFLOW[task.workflow].short}</span>
                  <span>{task.mode === 'manual' ? 'Manual assignment' : 'Coordinator plan'}</span>
                  {task.latestRevision > 0 ? <span>Revision {task.latestRevision}</span> : null}
                  <span>Updated {when(task.updatedAt)}</span>
                </div>
              </li>
            ))}
          </ul>
        </div>
      )}
    </Shell>
  );
}

export type NewTaskValues = Readonly<Record<string, string | readonly string[]>>;

const value = (values: NewTaskValues, key: string, fallback = ''): string => {
  // eslint-disable-next-line security/detect-object-injection
  const found = values[key];
  return typeof found === 'string' ? found : fallback;
};
const values = (vals: NewTaskValues, key: string): readonly string[] => {
  // eslint-disable-next-line security/detect-object-injection
  const found = vals[key] as string | readonly string[] | undefined;
  return typeof found === 'string' ? [found] : (found ?? []);
};

function hasSynthesis(
  teammate: TeammateView,
  workflow: Workflow,
  skills: ReadonlyMap<string, readonly Workflow[]>,
): boolean {
  return teammate.skills.some(
    (skill) => skills.get(`${skill.id}:${skill.version}`)?.includes(workflow) === true,
  );
}

/** Sources of this workflow the teammate can use right now (its effective capabilities). */
function usableSources(
  teammate: TeammateView,
  sources: readonly SourceKind[],
): readonly SourceKind[] {
  const effective = new Set(
    teammate.capabilities.filter((c) => c.effective).map((c) => c.capability),
  );
  // eslint-disable-next-line security/detect-object-injection
  return sources.filter((source) => effective.has(SOURCE_CAPABILITY[source]));
}

function AssignmentRows(props: {
  readonly specialists: readonly TeammateView[];
  readonly sources: readonly SourceKind[];
  readonly values: NewTaskValues;
}): Html {
  const { specialists, sources } = props;
  return (
    <fieldset class="field" data-show-when="mode=manual">
      <legend>Assignments (manual)</legend>
      <p class="hint">
        Fill one to three rows. Empty rows are ignored. Each specialist works in parallel.
      </p>
      <div class="stack-sm">
        {[0, 1, 2].map((index) => (
          <div class="assign-row">
            <div class="field">
              <label for={`a${index}-tm`}>Specialist {index + 1}</label>
              <select id={`a${index}-tm`} name={`a${index}.teammate`}>
                <option value="">(none)</option>
                {specialists.map((t) => (
                  <option
                    value={t.id}
                    selected={value(props.values, `a${index}.teammate`) === t.id}
                    data-sources={usableSources(t, sources).join(' ')}
                  >
                    {t.name} · {t.role}
                  </option>
                ))}
              </select>
            </div>
            <div class="field">
              <label for={`a${index}-brief`}>Assignment</label>
              <textarea id={`a${index}-brief`} name={`a${index}.brief`} rows="2" maxlength="1200">
                {value(props.values, `a${index}.brief`)}
              </textarea>
            </div>
            <fieldset class="field" data-sources-for={`a${index}-tm`}>
              <legend class="sr-only">Sources for specialist {index + 1}</legend>
              <div class="checks">
                {sources.map((source) => (
                  <label>
                    <input
                      type="checkbox"
                      name={`a${index}.sources`}
                      value={source}
                      checked={
                        values(props.values, `a${index}.sources`).length === 0
                          ? true
                          : values(props.values, `a${index}.sources`).includes(source)
                      }
                    />
                    {sourceLabel(source)}
                  </label>
                ))}
              </div>
            </fieldset>
          </div>
        ))}
      </div>
    </fieldset>
  );
}

export function NewTaskPage(props: {
  readonly ctx: PageCtx;
  readonly teammates: readonly TeammateView[];
  /** skill id:version to workflows it can synthesize */
  readonly synthesis: ReadonlyMap<string, readonly Workflow[]>;
  readonly values: NewTaskValues;
  readonly error?: string;
  readonly defaults: { readonly repository: string | null; readonly issue: number | null };
}): Html {
  const { ctx, teammates } = props;
  const workflow = (value(props.values, 'workflow') || 'research_brief') as Workflow;
  const mode = value(props.values, 'mode', 'manual');
  const owners = teammates.filter((t) => hasSynthesis(t, workflow, props.synthesis));
  const specialists = teammates.filter((t) => !hasSynthesis(t, workflow, props.synthesis));
  const defaultOwner = value(props.values, 'resultOwner', owners.at(0)?.id ?? '');
  const sources = workflowSources(workflow);
  return (
    <Shell ctx={ctx} title="New task">
      <PageHead
        title="New task"
        lead="Describe the outcome you need. Choose specialists yourself, or let the coordinator propose a plan you approve before anything runs."
        crumbs={[{ label: 'Tasks', href: segPath(ctx.segment, '/tasks') }]}
      />
      {teammates.length === 0 ? (
        <Alert tone="info" title="Add teammates first">
          <p>
            You need teammates in {ctx.segment.name}.{' '}
            <a href={segPath(ctx.segment, TEAMMATES_PATH)}>Add the starter team</a>, then come back.
          </p>
        </Alert>
      ) : null}
      {props.error === undefined ? null : (
        <div class="notice">
          <Alert tone="danger" title="The task was not started">
            <p>{props.error}</p>
          </Alert>
        </div>
      )}
      <form
        class="card card-body form-grid"
        method="get"
        action={segPath(ctx.segment, NEW_TASK_PATH)}
        aria-label="Workflow"
      >
        <fieldset class="field">
          <legend>Workflow</legend>
          <div class="choices">
            {(Object.keys(WORKFLOW) as Workflow[]).map((key) => (
              <label class="choice">
                <input
                  type="radio"
                  name="workflow"
                  value={key}
                  checked={key === workflow}
                  data-autosubmit
                />
                <span>
                  <strong>{workflowInfo(key).label}</strong>
                  <span class="subtle">
                    <br />
                    {workflowInfo(key).explain}
                  </span>
                </span>
              </label>
            ))}
          </div>
        </fieldset>
        <input type="hidden" name="mode" value={mode} />
        {value(props.values, 'conversation') === '' ? null : (
          <input type="hidden" name="conversation" value={value(props.values, 'conversation')} />
        )}
        <noscript>
          <button class="btn" type="submit">
            Use this workflow
          </button>
        </noscript>
      </form>
      <form
        class="card card-body form-grid footer-note"
        method="post"
        action={segPath(ctx.segment, '/tasks')}
        data-draft={`new-task-${workflow}`}
      >
        <Csrf session={ctx.session} />
        <input
          type="hidden"
          name="clientRequestId"
          value={value(props.values, 'clientRequestId', crypto.randomUUID())}
        />
        <input type="hidden" name="workflow" value={workflow} />
        <input type="hidden" name="conversationId" value={value(props.values, 'conversation')} />
        <div class="field">
          <label for="question">What do you need?</label>
          <textarea id="question" name="question" required maxlength="1200" data-ctrl-enter>
            {value(props.values, 'question')}
          </textarea>
          <p class="hint">
            Be specific about the decision or outcome. Specialists work only from the{' '}
            {sources.map(sourceLabel).join(' and ')}.
          </p>
        </div>
        {workflow === 'metrics_explanation' ? (
          <div class="row">
            <div class="field">
              <label for="baseline">Baseline month</label>
              <input
                id="baseline"
                name="baseline"
                type="month"
                required
                value={value(props.values, 'baseline', '2026-09')}
              />
            </div>
            <div class="field">
              <label for="current">Current month</label>
              <input
                id="current"
                name="current"
                type="month"
                required
                value={value(props.values, 'current', '2026-10')}
              />
            </div>
            <div class="field">
              <label for="groupBy">Group by</label>
              <select id="groupBy" name="groupBy">
                <option
                  value="region"
                  selected={value(props.values, 'groupBy', 'region') === 'region'}
                >
                  Region
                </option>
                <option value="channel" selected={value(props.values, 'groupBy') === 'channel'}>
                  Channel
                </option>
              </select>
            </div>
          </div>
        ) : null}
        {workflow === 'engineering_proposal' ? (
          <div class="row">
            <div class="field">
              <label for="repository">Repository</label>
              <input
                id="repository"
                name="repository"
                value={value(props.values, 'repository', props.defaults.repository ?? '')}
                required
                pattern="[\w.-]+/[\w.-]+"
              />
              <p class="hint">Must be allowlisted for this segment.</p>
            </div>
            <div class="field">
              <label for="issue">Issue number</label>
              <input
                id="issue"
                name="issueNumber"
                type="number"
                min="1"
                required
                value={value(
                  props.values,
                  'issueNumber',
                  props.defaults.issue === null ? '' : String(props.defaults.issue),
                )}
              />
            </div>
          </div>
        ) : null}
        <div class="field">
          <label for="owner">Result owner</label>
          <select id="owner" name="resultOwner" required>
            {owners.map((t) => (
              <option value={t.id} selected={t.id === defaultOwner}>
                {t.name}
              </option>
            ))}
          </select>
          <p class="hint">
            {owners.length === 0
              ? `No teammate has a synthesis skill for ${workflowInfo(workflow).short.toLowerCase()} yet. Attach one first.`
              : 'Owns the combined result and writes it from the contributions.'}
          </p>
        </div>
        <fieldset class="field">
          <legend>How should the work be split?</legend>
          <div class="choices">
            <label class="choice">
              <input type="radio" name="mode" value="manual" checked={mode !== 'coordinated'} />
              <span>
                <strong>I'll assign specialists</strong>
                <br />
                <span class="subtle">They start in parallel as soon as you submit.</span>
              </span>
            </label>
            <label class="choice">
              <input
                type="radio"
                name="mode"
                value="coordinated"
                checked={mode === 'coordinated'}
              />
              <span>
                <strong>Coordinator proposes a plan</strong>
                <br />
                <span class="subtle">Nothing runs until you review and approve the plan.</span>
              </span>
            </label>
          </div>
        </fieldset>
        <AssignmentRows specialists={specialists} sources={sources} values={props.values} />
        <div class="row">
          <SubmitButton label="Start task" />
          <span class="subtle">
            <span class="kbd">Ctrl</span> + <span class="kbd">Enter</span> also submits.
          </span>
        </div>
      </form>
    </Shell>
  );
}

function Cite(props: { readonly ids: readonly string[]; readonly calcs: readonly string[] }): Html {
  return (
    <Fragment>
      {props.ids.map((id) => (
        <a class="cite" href={`#ev-${id}`} aria-label={`Source ${id}`}>
          {id}
        </a>
      ))}
      {props.calcs.map((id) => (
        <a class="cite" href={`#calc-${id}`} aria-label={`Calculation ${id}`}>
          {id}
        </a>
      ))}
    </Fragment>
  );
}

function Statements(props: { readonly statements: readonly Statement[] }): Html {
  return (
    <ul class="stmt">
      {props.statements.map((s) => (
        <li data-kind={s.kind} data-support={s.support}>
          <span class="kind">{STATEMENT[s.kind]}</span>
          {s.text}
          <Cite ids={s.evidenceIds} calcs={s.calculationIds} />
          {s.support === 'unsupported' ? (
            <span class="unverified">Not supported by its cited sources; treat as inference</span>
          ) : null}
        </li>
      ))}
    </ul>
  );
}

function PlanCard(props: {
  readonly ctx: PageCtx;
  readonly detail: TaskDetail;
  readonly plan: PlanView;
  readonly teammates: readonly TeammateView[];
}): Html {
  const { ctx, detail, plan } = props;
  const names = new Map(props.teammates.map((t) => [t.id, t.name]));
  const base = segPath(ctx.segment, `/tasks/${detail.task.id}`);
  return (
    <section class="card decision" id="decision" aria-labelledby="plan-h" tabindex="-1">
      <div class="card-body stack">
        <h2 id="plan-h">
          <Icon name="clock" />
          Review plan version {plan.version} (
          {plan.author === 'coordinator' ? 'proposed by the coordinator' : 'edited by you'})
        </h2>
        <p>{plan.content.summary}</p>
        <ol class="plan-list">
          {plan.content.assignments.map((a) => (
            <li class="plan-item">
              <h3>
                {names.get(a.teammateId) ?? 'Unknown teammate'}: {a.key}
              </h3>
              <p>{a.brief}</p>
              <p class="subtle">
                Delivers: {a.deliverable}. Sources: {a.sources.map(sourceLabel).join(', ')}
                {a.dependsOn.length === 0
                  ? '. Runs in parallel.'
                  : `. Waits for ${a.dependsOn.join(', ')}.`}
              </p>
            </li>
          ))}
        </ol>
        <dl class="kv">
          <dt>Result owner</dt>
          <dd>{names.get(plan.content.synthesisOwner) ?? 'Unknown'}</dd>
          <dt>Capabilities used</dt>
          <dd>{plan.capabilities.map(capabilityLabel).join(', ')}</dd>
          <dt>External effects</dt>
          <dd>
            {plan.content.expectedEffects.length === 0
              ? 'None. Reading only.'
              : plan.content.expectedEffects.join(' ')}{' '}
            Publishing anything later needs its own approval of the exact content.
          </dd>
        </dl>
        <form class="decision-actions" method="post" action={`${base}/plan/decision`}>
          <Csrf session={ctx.session} />
          <input type="hidden" name="version" value={String(plan.version)} />
          <input type="hidden" name="expectedDigest" value={plan.digest} />
          <SubmitButton
            label={`Approve plan v${plan.version} and start`}
            kind="btn-approve"
            name="decision"
            value="approve"
          />
          <SubmitButton label="Reject plan" kind="btn-danger" name="decision" value="reject" />
        </form>
        <details>
          <summary>Edit the plan</summary>
          <form class="form-grid footer-note" method="post" action={`${base}/plan/edit`}>
            <Csrf session={ctx.session} />
            <input type="hidden" name="baseVersion" value={String(plan.version)} />
            <input type="hidden" name="summary" value={plan.content.summary} />
            {plan.content.assignments.map((a, index) => (
              <div class="assign-row">
                <input type="hidden" name={`p${index}.key`} value={a.key} />
                <input type="hidden" name={`p${index}.deliverable`} value={a.deliverable} />
                <div class="field">
                  <label for={`p${index}-tm`}>Teammate for {a.key}</label>
                  <select id={`p${index}-tm`} name={`p${index}.teammate`}>
                    {props.teammates
                      .filter((t) => t.id !== plan.content.synthesisOwner)
                      .map((t) => (
                        <option value={t.id} selected={t.id === a.teammateId}>
                          {t.name}
                        </option>
                      ))}
                  </select>
                </div>
                <div class="field">
                  <label for={`p${index}-brief`}>Assignment</label>
                  <textarea
                    id={`p${index}-brief`}
                    name={`p${index}.brief`}
                    rows="3"
                    maxlength="1200"
                  >
                    {a.brief}
                  </textarea>
                </div>
                <div class="checks">
                  {workflowSources(detail.task.workflow).map((source) => (
                    <label>
                      <input
                        type="checkbox"
                        name={`p${index}.sources`}
                        value={source}
                        checked={a.sources.includes(source)}
                      />
                      {sourceLabel(source)}
                    </label>
                  ))}
                  <label>
                    <input type="checkbox" name={`p${index}.remove`} value="1" />
                    Remove this assignment
                  </label>
                </div>
              </div>
            ))}
            <p class="hint">
              Saving creates plan version {plan.version + 1}. You review it again before anything
              runs.
            </p>
            <SubmitButton label="Save as a new plan version" kind="btn" />
          </form>
          <form class="form-grid footer-note" method="post" action={`${base}/plan/replan`}>
            <Csrf session={ctx.session} />
            <div class="field">
              <label for="feedback">Or ask the coordinator for a different plan</label>
              <textarea id="feedback" name="feedback" rows="2" required maxlength="2000"></textarea>
            </div>
            <SubmitButton label="Request a new plan" kind="btn" />
          </form>
        </details>
      </div>
    </section>
  );
}

function ApprovalCard(props: {
  readonly ctx: PageCtx;
  readonly detail: TaskDetail;
  readonly approval: ActionApprovalView;
}): Html {
  const { ctx, detail, approval } = props;
  const p = approval.proposal;
  return (
    <section class="card decision" id="decision" aria-labelledby="ap-h" tabindex="-1">
      <div class="card-body stack">
        <h2 id="ap-h">
          <Icon name="shield" />
          Approve this exact Google Doc?
        </h2>
        <dl class="kv">
          <dt>Account</dt>
          <dd>
            <strong>{p.account}</strong>
          </dd>
          <dt>Destination</dt>
          <dd>{p.destination}</dd>
          <dt>Operation</dt>
          <dd>Create one new document (Google Docs)</dd>
          <dt>Title</dt>
          <dd>
            <strong>{p.documentTitle}</strong>
          </dd>
          <dt>Revision</dt>
          <dd>Revision {p.revision} of this task</dd>
          <dt>Length</dt>
          <dd>{p.wordCount} words</dd>
          <dt>Expires</dt>
          <dd>{when(approval.expiresAt)}</dd>
        </dl>
        <div>
          <p class="section-title">Exact content that will be written</p>
          <pre class="code-block" tabindex="0" aria-label="Document content">
            {p.contentMarkdown}
          </pre>
        </div>
        <ul class="risks">
          {p.consequences.map((c) => (
            <li>{c}</li>
          ))}
        </ul>
        <form
          class="decision-actions"
          method="post"
          action={segPath(ctx.segment, `/tasks/${detail.task.id}/action`)}
        >
          <Csrf session={ctx.session} />
          <input type="hidden" name="approvalId" value={approval.id} />
          <input type="hidden" name="expectedDigest" value={approval.digest} />
          <SubmitButton
            label="Approve and create the document"
            kind="btn-approve"
            name="decision"
            value="approve"
          />
          <SubmitButton label="Reject" kind="btn-danger" name="decision" value="reject" />
        </form>
      </div>
    </section>
  );
}

function QuestionForm(props: {
  readonly ctx: PageCtx;
  readonly base: string;
  readonly a: AssignmentView;
}): Html {
  const { ctx, base, a } = props;
  return (
    <form class="stack-sm" method="post" action={`${base}/follow-up`}>
      <Csrf session={ctx.session} />
      <input type="hidden" name="clientRequestId" value={crypto.randomUUID()} />
      <input type="hidden" name="kind" value="answer" />
      <input type="hidden" name="assignmentId" value={a.id} />
      <p>
        <strong>{a.teammateName} asks:</strong> {a.question}
      </p>
      <div class="field">
        <label for={`ans-${a.id}`}>Your answer</label>
        <textarea id={`ans-${a.id}`} name="text" rows="2" required maxlength="2000"></textarea>
      </div>
      <SubmitButton label={`Answer ${a.teammateName}`} kind="btn" />
    </form>
  );
}

function MissingBlock(props: {
  readonly ctx: PageCtx;
  readonly base: string;
  readonly missing: readonly AssignmentView[];
}): Html {
  const { ctx, base, missing } = props;
  return (
    <div class="stack-sm">
      <p>
        <strong>
          {missing.length} contribution{missing.length === 1 ? '' : 's'} did not finish.
        </strong>{' '}
        The others are kept.
      </p>
      <ul>
        {missing.map((a) => (
          <li>
            {a.teammateName} ({a.key}): {a.errorMessage ?? ASSIGNMENT_STATUS[a.status].label}
          </li>
        ))}
      </ul>
      <form class="decision-actions" method="post" action={`${base}/missing`}>
        <Csrf session={ctx.session} />
        <SubmitButton label="Retry them" kind="btn-primary" name="decision" value="retry" />
        <SubmitButton label="Continue without them" kind="btn" name="decision" value="proceed" />
      </form>
      <p class="subtle">
        Continuing writes the result from the finished contributions and states exactly what is
        missing.
      </p>
    </div>
  );
}

function FailedBlock(props: {
  readonly ctx: PageCtx;
  readonly base: string;
  readonly detail: TaskDetail;
}): Html {
  const { ctx, base, detail } = props;
  return (
    <div class="stack-sm">
      <p>{detail.task.errorMessage ?? 'This task stopped.'}</p>
      <div class="row">
        <form method="post" action={`${base}/retry`}>
          <Csrf session={ctx.session} />
          <SubmitButton label="Retry the failed step" />
        </form>
        <form method="post" action={`${base}/cancel`}>
          <Csrf session={ctx.session} />
          <SubmitButton label="Cancel task" kind="btn-danger" />
        </form>
      </div>
    </div>
  );
}

function UncertainBlock(props: {
  readonly ctx: PageCtx;
  readonly base: string;
  readonly detail: TaskDetail;
}): Html {
  const { ctx, base, detail } = props;
  return (
    <div class="stack-sm">
      <p>{detail.task.errorMessage}</p>
      <form method="post" action={`${base}/reconcile`}>
        <Csrf session={ctx.session} />
        <SubmitButton label="Check for the document" />
      </form>
    </div>
  );
}

function decisionParts(ctx: PageCtx, detail: TaskDetail, base: string): Html[] {
  const status = detail.task.status;
  const questions = detail.assignments.filter((a) => a.status === 'needs_input');
  const missing = detail.assignments.filter(
    (a) => a.status === 'failed' || a.status === 'timed_out',
  );
  const parts: Html[] = questions.map((a) => <QuestionForm ctx={ctx} base={base} a={a} />);
  if (status === 'needs_input' && missing.length > 0)
    parts.push(<MissingBlock ctx={ctx} base={base} missing={missing} />);
  if (status === 'failed') parts.push(<FailedBlock ctx={ctx} base={base} detail={detail} />);
  if (status === 'outcome_uncertain')
    parts.push(<UncertainBlock ctx={ctx} base={base} detail={detail} />);
  return parts;
}

function DecisionCard(props: {
  readonly ctx: PageCtx;
  readonly detail: TaskDetail;
  readonly teammates: readonly TeammateView[];
}): Html | null {
  const { ctx, detail } = props;
  const base = segPath(ctx.segment, `/tasks/${detail.task.id}`);
  const status = detail.task.status;
  if (status === 'plan_review') {
    const plan = detail.plans.find((p) => p.state === 'proposed');
    return plan === undefined ? null : (
      <PlanCard ctx={ctx} detail={detail} plan={plan} teammates={props.teammates} />
    );
  }
  if (status === 'awaiting_action_approval') {
    const approval = detail.approvals.find((a) => a.state === 'pending');
    return approval === undefined ? null : (
      <ApprovalCard ctx={ctx} detail={detail} approval={approval} />
    );
  }
  const parts = decisionParts(ctx, detail, base);
  if (parts.length === 0) return null;
  const tone = status === 'failed' || status === 'outcome_uncertain' ? 'decision-bad' : '';
  return (
    <section class={`card decision ${tone}`} id="decision" aria-labelledby="dec-h" tabindex="-1">
      <div class="card-body stack">
        <h2 id="dec-h">
          <Icon name={tone === '' ? 'clock' : 'alert'} />
          {status === 'failed'
            ? 'This task stopped'
            : status === 'outcome_uncertain'
              ? 'Did the write happen?'
              : 'Your teammates need you'}
        </h2>
        {parts}
      </div>
    </section>
  );
}

function Published(props: { readonly ctx: PageCtx; readonly approval: ActionApprovalView }): Html {
  const action = props.approval.action;
  const href = safeHref(action?.externalUrl ?? null, props.ctx.segment.id);
  return (
    <Alert tone="ok" title="Published">
      <p>
        Created “{props.approval.proposal.documentTitle}” in {props.approval.proposal.account}.
        Confirmed by the provider {when(action?.confirmedAt ?? null)}.
      </p>
      {href === null ? null : (
        <p class="actions">
          <a class="btn btn-sm" href={href} target="_blank" rel="noopener noreferrer">
            <Icon name="external" small />
            Open the document
          </a>
        </p>
      )}
    </Alert>
  );
}

function ResultMeta(props: { readonly revision: RevisionView }): Html {
  const { revision } = props;
  return (
    <p class="model-meta footer-note">
      <span>Model {revision.generation.modelVersion}</span>
      {revision.generation.responseId === null ? null : (
        <span>Response {revision.generation.responseId}</span>
      )}
      {revision.generation.planVersion === null ? (
        <span>Manual assignment</span>
      ) : (
        <span>Plan version {revision.generation.planVersion}</span>
      )}
      {revision.generation.skills.map((s) => (
        <span>
          {s.name} v{s.version}
        </span>
      ))}
      {revision.generation.repositoryRevision === null ? null : (
        <span>Repository at {revision.generation.repositoryRevision.slice(0, 12)}</span>
      )}
      <span>{when(revision.createdAt)}</span>
    </p>
  );
}

function RescopeForm(props: {
  readonly ctx: PageCtx;
  readonly base: string;
  readonly metrics: NonNullable<TaskDetail['scope']['metrics']>;
}): Html {
  const { ctx, base, metrics } = props;
  return (
    <form class="form-grid" method="post" action={`${base}/follow-up`}>
      <Csrf session={ctx.session} />
      <input type="hidden" name="clientRequestId" value={crypto.randomUUID()} />
      <input type="hidden" name="kind" value="rescope" />
      <input type="hidden" name="text" value="Change the comparison" />
      <p class="section-title">Change the comparison</p>
      <div class="row">
        <div class="field">
          <label for="rs-b">Baseline</label>
          <input id="rs-b" type="month" name="baseline" value={metrics.baseline} required />
        </div>
        <div class="field">
          <label for="rs-c">Current</label>
          <input id="rs-c" type="month" name="current" value={metrics.current} required />
        </div>
        <div class="field">
          <label for="rs-g">Group by</label>
          <select id="rs-g" name="groupBy">
            <option value="region" selected={metrics.groupBy === 'region'}>
              Region
            </option>
            <option value="channel" selected={metrics.groupBy === 'channel'}>
              Channel
            </option>
          </select>
        </div>
      </div>
      <SubmitButton label="Re-run with this comparison" kind="btn" />
    </form>
  );
}

function ResultActions(props: {
  readonly ctx: PageCtx;
  readonly detail: TaskDetail;
  readonly revision: RevisionView;
  readonly base: string;
}): Html {
  const { ctx, detail, revision, base } = props;
  return (
    <div class="report-body stack">
      <form
        class="form-grid"
        method="post"
        action={`${base}/follow-up`}
        data-draft={`rev-${detail.task.id}`}
      >
        <Csrf session={ctx.session} />
        <input type="hidden" name="clientRequestId" value={crypto.randomUUID()} />
        <input type="hidden" name="kind" value="revise" />
        <div class="field">
          <label for="revise">Request a revision</label>
          <textarea
            id="revise"
            name="text"
            rows="2"
            required
            maxlength="2000"
            placeholder="For example: treat the conflicting figures as unresolved and add the migration effort."
            data-ctrl-enter
          ></textarea>
          <p class="hint">
            The original stays as revision {revision.revision}; the change becomes revision{' '}
            {revision.revision + 1}.
          </p>
        </div>
        <SubmitButton label="Request revision" kind="btn" />
      </form>
      {detail.task.workflow === 'metrics_explanation' && detail.scope.metrics !== null ? (
        <RescopeForm ctx={ctx} base={base} metrics={detail.scope.metrics} />
      ) : null}
      <form method="post" action={`${base}/publish`}>
        <Csrf session={ctx.session} />
        <input type="hidden" name="revision" value={String(revision.revision)} />
        <SubmitButton label={`Prepare revision ${revision.revision} for Google Docs`} kind="btn" />
        <p class="hint">
          You will see the exact account, title and content before anything is written.
        </p>
      </form>
    </div>
  );
}

function ResultCard(props: {
  readonly ctx: PageCtx;
  readonly detail: TaskDetail;
  readonly revision: RevisionView;
}): Html {
  const { ctx, detail, revision } = props;
  const base = segPath(ctx.segment, `/tasks/${detail.task.id}`);
  const latest = revision.revision === detail.task.latestRevision;
  const canAct = latest && (detail.task.status === 'ready' || detail.task.status === 'completed');
  const several = detail.revisions.length > 1;
  return (
    <section class="card report" aria-labelledby="res-h" data-live="result">
      <div class="report-head">
        <div>
          <p class="section-title">
            Result · revision {revision.revision} of {detail.task.latestRevision}
            {latest ? '' : ' (older revision)'}
          </p>
          <h2 id="res-h">{revision.content.title}</h2>
          {revision.request === null ? null : (
            <p class="subtle">Revised on request: “{revision.request}”</p>
          )}
        </div>
        <div class="row">
          {several ? (
            <a
              class="btn btn-sm"
              href={`${base}/compare?from=${Math.max(1, revision.revision - 1)}&to=${revision.revision}`}
            >
              Compare versions
            </a>
          ) : null}
          <a class="btn btn-sm" href={`${base}/revisions/${revision.revision}.md`} download>
            <Icon name="download" small />
            Markdown
          </a>
        </div>
      </div>
      <div class="report-body">
        <p>{revision.content.summary}</p>
        {revision.unsupported > 0 ? <UnsupportedNote count={revision.unsupported} /> : null}
        {revision.content.sections.map((section) => (
          <section class="result-section footer-note">
            <h3>{section.heading}</h3>
            {section.statements.length === 0 ? (
              <p class="muted">Nothing in this section.</p>
            ) : (
              <Statements statements={section.statements} />
            )}
          </section>
        ))}
        {revision.content.limitations.length === 0 ? null : (
          <section class="result-section footer-note">
            <h3>Limitations</h3>
            <ul class="limitations">
              {revision.content.limitations.map((l) => (
                <li>{l}</li>
              ))}
            </ul>
          </section>
        )}
        {revision.calculations.length === 0 ? null : <Calculations revision={revision} />}
        <ResultMeta revision={revision} />
      </div>
      {several ? (
        <nav class="report-foot" aria-label="Revisions">
          {detail.revisions.map((r) => (
            <a
              class="btn btn-sm"
              href={`${base}?rev=${r.revision}`}
              aria-current={r.revision === revision.revision ? 'true' : undefined}
            >
              Revision {r.revision}
            </a>
          ))}
        </nav>
      ) : null}
      {canAct ? <ResultActions ctx={ctx} detail={detail} revision={revision} base={base} /> : null}
    </section>
  );
}

function UnsupportedNote(props: { readonly count: number }): Html {
  const one = props.count === 1;
  return (
    <div class="footer-note">
      <Alert tone="warn" live={false}>
        <p>
          {props.count} statement{one ? ' is' : 's are'} not supported by {one ? 'its' : 'their'}{' '}
          cited sources and {one ? 'is' : 'are'} marked as inference.
        </p>
      </Alert>
    </div>
  );
}

/** One comparison per revision, so the grouping and periods label the columns, not every cell. */
function groupLabel(revision: RevisionView): string {
  const by = revision.calculations[0]?.groupBy ?? 'group';
  return by.charAt(0).toUpperCase() + by.slice(1);
}

function Calculations(props: { readonly revision: RevisionView }): Html {
  return (
    <section class="result-section footer-note" aria-labelledby="calc-h">
      <h3 id="calc-h">Calculations (computed by the workbench, not the model)</h3>
      <div class="table-wrap">
        <table class="calc-table">
          <thead>
            <tr>
              <th scope="col">ID</th>
              <th scope="col">Metric</th>
              <th scope="col">{groupLabel(props.revision)}</th>
              <th scope="col" class="num">
                {props.revision.calculations[0]?.baseline ?? 'Baseline'}
              </th>
              <th scope="col" class="num">
                {props.revision.calculations[0]?.current ?? 'Current'}
              </th>
              <th scope="col" class="num">
                Change
              </th>
              <th scope="col">Source</th>
            </tr>
          </thead>
          <tbody>
            {props.revision.calculations.map((c) => (
              <tr id={`calc-${c.id}`}>
                <td>{c.id}</td>
                <td>
                  {c.metric} <span class="subtle">({c.unit})</span>
                </td>
                <td>{c.group}</td>
                <td class="num">{c.baselineValue.toLocaleString('en-US')}</td>
                <td class="num">{c.currentValue.toLocaleString('en-US')}</td>
                <td class="num">
                  {c.change > 0 ? '+' : ''}
                  {c.change.toLocaleString('en-US')}
                  {c.changePct === null ? '' : ` (${c.changePct > 0 ? '+' : ''}${c.changePct}%)`}
                </td>
                <td>
                  <a class="cite" href={`#ev-${c.evidenceId}`}>
                    {c.evidenceId}
                  </a>{' '}
                  <span class="subtle">{c.query}</span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function Assignment(props: { readonly a: AssignmentView }): Html {
  const { a } = props;
  const info = ASSIGNMENT_STATUS[a.status];
  return (
    <article class="asg" data-status={a.status} aria-label={`${a.teammateName}: ${info.label}`}>
      <div class="asg-head">
        <div>
          <h3>{a.teammateName}</h3>
          <p class="subtle">{a.key}</p>
        </div>
        <span class={`status status-${info.tone}`}>{info.label}</span>
      </div>
      <p>{a.brief}</p>
      <p class="subtle">
        {a.sources.map(sourceLabel).join(', ')} ·{' '}
        {a.skills.map((s) => `${s.name} v${s.version}`).join(', ') || 'no skills'}
        {a.attempt > 1 ? ` · attempt ${a.attempt}` : ''}
      </p>
      <p class="asg-times">
        {a.startedAt === null ? 'Not started' : `Started ${when(a.startedAt)}`}
        {a.finishedAt === null ? '' : ` · finished ${when(a.finishedAt)}`}
        {a.model === null ? '' : ` · ${a.model.modelVersion} ${a.model.responseId ?? ''}`}
      </p>
      {a.errorMessage === null ? null : <p class="blocked">{a.errorMessage}</p>}
      {a.output === null ? null : (
        <details>
          <summary>Contribution: {a.output.statements.length} statements</summary>
          <p class="footer-note">{a.output.summary}</p>
          <Statements statements={a.output.statements} />
          {a.output.gaps.length === 0 ? null : (
            <p class="subtle footer-note">Gaps: {a.output.gaps.join(' ')}</p>
          )}
        </details>
      )}
    </article>
  );
}

function EvidenceList(props: {
  readonly ctx: PageCtx;
  readonly evidence: readonly EvidenceView[];
  readonly cited: ReadonlySet<string>;
}): Html {
  return (
    <section class="card panel" aria-labelledby="ev-h" data-live="evidence">
      <div class="panel-head">
        <h2 id="ev-h">
          <Icon name="file" />
          Evidence ({props.evidence.length})
        </h2>
      </div>
      <div class="panel-body">
        {props.evidence.length === 0 ? (
          <p class="muted">Sources appear here as specialists read them.</p>
        ) : (
          <ol class="evidence">
            {props.evidence.map((e) => {
              const href = safeHref(e.url, props.ctx.segment.id);
              return (
                <li class="ev" id={`ev-${e.id}`}>
                  <div class="ev-head">
                    <span class="ev-id">{e.id}</span>
                    <div>
                      <p class="ev-title">{e.title}</p>
                      <p class="ev-meta">
                        {e.location} ·{' '}
                        {e.modifiedAt === null
                          ? 'date unknown'
                          : `dated ${e.modifiedAt.slice(0, 10)}`}
                        {e.stale ? ' · ' : ''}
                        {e.stale ? <span class="badge badge-bad">Stale</span> : null}
                        {props.cited.has(e.id) ? ' · cited' : ''}
                      </p>
                    </div>
                  </div>
                  <details>
                    <summary>Show passage</summary>
                    <pre class="code-block">{e.excerpt}</pre>
                  </details>
                  <div class="ev-links">
                    <span class="subtle">{e.provenance}</span>
                    {e.sourceRevision === null ? null : (
                      <span class="subtle">Source version {e.sourceRevision}</span>
                    )}
                    {href === null ? null : (
                      <a href={href} target="_blank" rel="noopener noreferrer">
                        Open source
                      </a>
                    )}
                  </div>
                </li>
              );
            })}
          </ol>
        )}
      </div>
    </section>
  );
}

function Discussion(props: { readonly ctx: PageCtx; readonly detail: TaskDetail }): Html {
  const { ctx, detail } = props;
  const pending = detail.messages.some((m) => m.pending);
  return (
    <section class="card" aria-labelledby="disc-h" data-live="discussion">
      <div class="panel-head">
        <h2 id="disc-h">Discussion</h2>
        {pending ? <span class="status status-active">Waiting for a reply</span> : null}
      </div>
      <div class="panel-body stack-sm">
        {detail.messages.length === 0 ? (
          <p class="muted">
            Ask the result owner about this task. Questions do not change the result; use “Request a
            revision” for that.
          </p>
        ) : null}
        <div class="msgs" aria-live="polite">
          {detail.messages.map((m) => (
            <div class={`msg msg-${m.role}`}>
              <span class="avatar" aria-hidden="true">
                {m.role === 'member' ? 'Y' : m.role === 'system' ? 'W' : 'T'}
              </span>
              <div>
                <div class="turn-head">
                  <strong>
                    {m.role === 'member'
                      ? 'You'
                      : m.role === 'system'
                        ? 'Workbench'
                        : 'Result owner'}
                  </strong>
                  <span>{when(m.at)}</span>
                </div>
                <div class="bubble">{m.text}</div>
              </div>
            </div>
          ))}
        </div>
        <form
          class="stack-sm"
          method="post"
          action={segPath(ctx.segment, `/tasks/${detail.task.id}/follow-up`)}
          data-draft={`ask-${detail.task.id}`}
        >
          <Csrf session={ctx.session} />
          <input type="hidden" name="clientRequestId" value={crypto.randomUUID()} />
          <input type="hidden" name="kind" value="question" />
          <div class="field">
            <label for="ask">Ask a question</label>
            <textarea
              id="ask"
              name="text"
              rows="2"
              required
              maxlength="2000"
              data-ctrl-enter
            ></textarea>
          </div>
          <SubmitButton label="Ask" kind="btn" />
        </form>
      </div>
    </section>
  );
}

const CANCELLABLE: readonly TaskDetail['task']['status'][] = [
  'planning',
  'running',
  'synthesizing',
  'plan_review',
  'needs_input',
  'ready',
  'awaiting_action_approval',
];
const CLOSED: readonly TaskDetail['task']['status'][] = ['completed', 'cancelled', 'declined'];
const BUSY: readonly TaskDetail['task']['status'][] = ['planning', 'running', 'synthesizing'];

function progressLine(detail: TaskDetail): string {
  if (detail.task.status === 'synthesizing') return 'Writing the combined result';
  if (detail.task.status === 'planning') return 'Drafting a plan';
  return `${detail.assignments.filter((a) => a.status === 'succeeded').length} of ${detail.assignments.filter((a) => a.status !== 'superseded').length} contributions in`;
}

function placeholderText(status: TaskDetail['task']['status']): string {
  if (status === 'plan_review')
    return 'The result appears here after you approve the plan and the specialists finish.';
  if (status === 'needs_input')
    return 'The result is written once the open decision above is resolved.';
  if (status === 'cancelled' || status === 'declined')
    return 'No result: this task was stopped before anything was written.';
  return 'The combined result appears here when the specialists finish.';
}

function ResultPlaceholder(props: { readonly detail: TaskDetail }): Html {
  const { detail } = props;
  return (
    <section class="card card-body" data-live="result">
      {BUSY.includes(detail.task.status) ? (
        <div class="stack-sm" aria-busy="true">
          <p class="progress-line">
            <span class="spinner" aria-hidden="true"></span>
            {progressLine(detail)}
          </p>
          <div class="skeleton skeleton-title"></div>
          <div class="skeleton skeleton-line"></div>
          <div class="skeleton skeleton-line"></div>
        </div>
      ) : (
        <p class="muted">{placeholderText(detail.task.status)}</p>
      )}
    </section>
  );
}

function dotClass(type: string): string {
  if (/failed|denied|uncertain|rejected/.test(type)) return 'dot-bad';
  if (/completed|succeeded|approved|created/.test(type)) return 'dot-ok';
  if (/requested|needs/.test(type)) return 'dot-wait';
  return 'dot-info';
}

function eventItem(e: TaskDetail['events'][number]): Html {
  return (
    <li>
      <span class={`dot ${dotClass(e.type)}`} aria-hidden="true"></span>
      <p class="tl-summary">{e.summary}</p>
      <p class="tl-meta">
        {when(e.at)}
        {e.durationMs === null ? '' : ` · ${(e.durationMs / 1000).toFixed(1)} s`}
      </p>
    </li>
  );
}

function ActivityPanel(props: { readonly events: TaskDetail['events'] }): Html {
  const recent = [...props.events].reverse();
  return (
    <section class="card panel" aria-labelledby="act-h" data-live="activity">
      <div class="panel-head">
        <h2 id="act-h">
          <Icon name="clock" />
          Activity
        </h2>
      </div>
      <ol class="panel-body timeline">{recent.slice(0, 6).map(eventItem)}</ol>
      {recent.length > 6 ? (
        <details class="activity-more">
          <summary>Show all {recent.length} events</summary>
          <ol class="panel-body timeline">{recent.slice(6).map(eventItem)}</ol>
        </details>
      ) : null}
    </section>
  );
}

function PlanHistory(props: { readonly plans: TaskDetail['plans'] }): Html {
  return (
    <section class="card panel" aria-labelledby="plans-h">
      <div class="panel-head">
        <h2 id="plans-h">Plan history</h2>
      </div>
      <ul class="panel-body stack-sm">
        {props.plans.map((p) => (
          <li>
            Version {p.version} by {p.author}: <strong>{p.state}</strong>{' '}
            {p.decidedAt === null ? '' : `(${when(p.decidedAt)})`}
          </li>
        ))}
      </ul>
    </section>
  );
}

export function TaskPage(props: {
  readonly ctx: PageCtx;
  readonly detail: TaskDetail;
  readonly teammates: readonly TeammateView[];
  readonly revision: number | null;
}): Html {
  const { ctx, detail } = props;
  const status = TASK_STATUS[detail.task.status];
  const shown = detail.revisions.find(
    (r) => r.revision === (props.revision ?? detail.task.latestRevision),
  );
  const published = [...detail.approvals].reverse().find((a) => a.action?.status === 'succeeded');
  const owner = props.teammates.find((t) => t.id === detail.task.resultOwner);
  const cited = new Set(shown?.evidenceIds ?? []);
  const live = !CLOSED.includes(detail.task.status);
  const base = segPath(ctx.segment, `/tasks/${detail.task.id}`);
  const contributed = detail.assignments.filter((a) => a.status === 'succeeded').length;
  const expected = detail.assignments.filter((a) => a.status !== 'superseded').length;
  return (
    <Shell ctx={ctx} title={detail.task.title}>
      <div
        data-task-version={String(detail.task.version)}
        data-poll={live ? `${base}/version` : undefined}
        data-segment={ctx.segment.id}
      >
        <PageHead
          title={detail.task.title}
          crumbs={[{ label: 'Tasks', href: segPath(ctx.segment, '/tasks') }]}
        >
          <Status status={detail.task.status} />
          {CANCELLABLE.includes(detail.task.status) ? (
            <form method="post" action={`${base}/cancel`}>
              <Csrf session={ctx.session} />
              <SubmitButton label="Cancel" kind="btn-ghost" small />
            </form>
          ) : null}
        </PageHead>
        <p class="muted" role="status" data-live="status-line">
          {status.explain}
        </p>
        <p class="subtle footer-note">
          {WORKFLOW[detail.task.workflow].label} ·{' '}
          {detail.task.mode === 'manual' ? 'manual assignment' : 'coordinator plan'} · result owner{' '}
          {owner?.name ?? 'unknown'} · {ctx.segment.name}
          {detail.task.conversationId === null ? '' : ' · started from a conversation'}
        </p>
        <div class="task-layout footer-note">
          <div class="stack">
            <div data-live="decision">
              {<DecisionCard ctx={ctx} detail={detail} teammates={props.teammates} />}
            </div>
            {published === undefined ? null : <Published ctx={ctx} approval={published} />}
            {shown === undefined ? (
              <ResultPlaceholder detail={detail} />
            ) : (
              <ResultCard ctx={ctx} detail={detail} revision={shown} />
            )}
            {detail.assignments.length === 0 ? null : (
              <section class="card card-body" aria-labelledby="asg-h" data-live="assignments">
                <h2 id="asg-h" class="section-title">
                  Specialist work ({contributed}/{expected} contributed)
                </h2>
                <div class="assignments">
                  {detail.assignments.map((a) => (
                    <Assignment a={a} />
                  ))}
                </div>
              </section>
            )}
            <Discussion ctx={ctx} detail={detail} />
          </div>
          <aside class="task-aside" aria-label="Evidence and activity">
            <EvidenceList ctx={ctx} evidence={detail.evidence} cited={cited} />
            {detail.plans.length === 0 ? null : <PlanHistory plans={detail.plans} />}
            <ActivityPanel events={detail.events} />
          </aside>
        </div>
      </div>
    </Shell>
  );
}

export function ComparePage(props: {
  readonly ctx: PageCtx;
  readonly detail: TaskDetail;
  readonly from: RevisionView;
  readonly to: RevisionView;
}): Html {
  const { ctx, detail, from, to } = props;
  const base = segPath(ctx.segment, `/tasks/${detail.task.id}`);
  const diff = to.parent === from.revision && to.diff !== null ? to.diff : null;
  const lines = (r: RevisionView) =>
    new Map(r.content.sections.map((s) => [s.heading, new Set(s.statements.map((st) => st.text))]));
  const a = lines(from);
  const b = lines(to);
  const headings = [...new Set([...a.keys(), ...b.keys()])];
  return (
    <Shell ctx={ctx} title="Compare revisions">
      <PageHead
        title={`Revision ${from.revision} → ${to.revision}`}
        lead={detail.task.title}
        crumbs={[
          { label: 'Tasks', href: segPath(ctx.segment, '/tasks') },
          { label: detail.task.title, href: base },
        ]}
      />
      <form class="card card-body row" method="get" action={`${base}/compare`}>
        <div class="field">
          <label for="from">From</label>
          <select id="from" name="from">
            {detail.revisions.map((r) => (
              <option value={String(r.revision)} selected={r.revision === from.revision}>
                Revision {r.revision}
              </option>
            ))}
          </select>
        </div>
        <div class="field">
          <label for="to">To</label>
          <select id="to" name="to">
            {detail.revisions.map((r) => (
              <option value={String(r.revision)} selected={r.revision === to.revision}>
                Revision {r.revision}
              </option>
            ))}
          </select>
        </div>
        <button class="btn" type="submit">
          Compare
        </button>
      </form>
      <div class="stack footer-note">
        {to.request === null ? null : (
          <Alert tone="info" live={false} title="Requested change">
            <p>{to.request}</p>
          </Alert>
        )}
        {diff === null ? null : (
          <section class="card card-body stack-sm" aria-labelledby="src-h">
            <h2 id="src-h">Sources</h2>
            <p>Added: {diff.sourcesAdded.length === 0 ? 'none' : diff.sourcesAdded.join(', ')}</p>
            <p>
              Removed: {diff.sourcesRemoved.length === 0 ? 'none' : diff.sourcesRemoved.join(', ')}
            </p>
          </section>
        )}
        {from.content.summary === to.content.summary ? null : (
          <section class="card card-body stack-sm">
            <h2>Summary</h2>
            <p class="diff-del">{from.content.summary}</p>
            <p class="diff-add">{to.content.summary}</p>
          </section>
        )}
        {headings.map((heading) => {
          const before = a.get(heading) ?? new Set<string>();
          const after = b.get(heading) ?? new Set<string>();
          const removed = [...before].filter((line) => !after.has(line));
          const added = [...after].filter((line) => !before.has(line));
          const kept = [...after].filter((line) => before.has(line)).length;
          return (
            <section class="card card-body stack-sm" aria-label={heading}>
              <h2>
                {heading}{' '}
                {added.length + removed.length === 0 ? (
                  <span class="badge badge-neutral">unchanged</span>
                ) : (
                  <span class="badge badge-seg">changed</span>
                )}
              </h2>
              <ul class="diff-list">
                {removed.map((line) => (
                  <li class="diff-del">
                    <span class="sr-only">Removed: </span>
                    {line}
                  </li>
                ))}
                {added.map((line) => (
                  <li class="diff-add">
                    <span class="sr-only">Added: </span>
                    {line}
                  </li>
                ))}
              </ul>
              {kept === 0 ? null : (
                <p class="subtle">
                  {kept} statement{kept === 1 ? '' : 's'} unchanged.
                </p>
              )}
            </section>
          );
        })}
      </div>
    </Shell>
  );
}
