import { citedEvidenceIds, reportSections, safeWorkbenchUrl } from '@agent-works/domain/workbench';

import { Fragment, h } from '../html.js';

import { Icon } from './icons.js';
import {
  Alert,
  Breadcrumbs,
  SimBadge,
  StatusPill,
  Time,
  duration,
  liveStatuses,
  modelLabel,
  statusLabel,
} from './views.js';

import type { IconName } from './icons.js';
import type { Html } from '../html.js';
import type {
  ReportItem,
  ReportSection,
  WorkbenchApproval,
  WorkbenchEvent,
  WorkbenchEvidence,
  WorkbenchStatus,
  WorkbenchTaskDetail,
} from '@agent-works/domain/workbench';

const eventTone = (type: WorkbenchEvent['type']): string => {
  if (type.endsWith('.failed') || type === 'retrieval.denied') return 'dot-bad';
  if (
    type === 'approval.requested' ||
    type === 'action.uncertain' ||
    type === 'task.cancel_requested'
  )
    return 'dot-wait';
  if (type.startsWith('action.')) return 'dot-sim';
  if (type.endsWith('.completed') || type === 'approval.approved' || type === 'draft.created')
    return 'dot-ok';
  return 'dot-info';
};

function Timeline(events: readonly WorkbenchEvent[]): Html {
  return (
    <ol class="timeline" aria-label="Activity timeline">
      {events.map((event) => (
        <li data-event={event.type}>
          <span class={`dot ${eventTone(event.type)}`} aria-hidden="true"></span>
          <p class="tl-summary">{event.summary}</p>
          <p class="tl-meta">
            {Time(event.at, false)}
            {event.durationMs === null ? '' : ` · took ${duration(event.durationMs)}`}
          </p>
        </li>
      ))}
    </ol>
  );
}

function EvidenceList(evidence: readonly WorkbenchEvidence[], cited: ReadonlySet<string>): Html {
  return (
    <ul class="evidence">
      {evidence.map((item) => {
        // Defence in depth: the API already filters, the view re-checks before emitting an href.
        const href = safeWorkbenchUrl(item.url);
        return (
          <li class="ev" id={`ev-${item.id}`} data-evidence={item.id}>
            <div class="ev-head">
              <span class="ev-id">{item.id}</span>
              <p class="ev-title">{item.title}</p>
            </div>
            <p class="ev-meta">
              Modified {Time(item.modifiedAt)} · retrieved {Time(item.retrievedAt, false)} ·{' '}
              {item.provenance}
              {cited.has(item.id) ? ' · cited in draft' : ' · not cited'}
            </p>
            <details>
              <summary>Show excerpt</summary>
              <p class="ev-excerpt">{item.excerpt}</p>
            </details>
            <div class="ev-links">
              {href === null ? (
                <span class="blocked" data-blocked-link="true">
                  Link unavailable: unsafe URL removed
                </span>
              ) : (
                <a href={href} data-source-link="true">
                  Open source {SimBadge('fixture')}
                </a>
              )}
            </div>
          </li>
        );
      })}
    </ul>
  );
}

function Cites(ids: readonly string[]): Html {
  return h(
    Fragment,
    null,
    ...ids.map((id) =>
      h('a', { class: 'cite', href: `#ev-${id}`, 'aria-label': `Source ${id}` }, id),
    ),
  );
}

function ReportItems(section: ReportSection): Html {
  const line = (item: ReportItem) => (
    <>
      {item.text}
      {Cites(item.evidenceIds)}
    </>
  );
  if (section.kind === 'summary')
    return (
      <>
        {section.items.map((item) => (
          <p>{item.text}</p>
        ))}
      </>
    );
  if (section.kind === 'causes')
    return (
      <>
        {section.items.map((item) => (
          <article class="cause">
            <h4>{item.title}</h4>
            <p>{line(item)}</p>
          </article>
        ))}
      </>
    );
  return (
    <ul>
      {section.items.map((item) => (
        <li>{line(item)}</li>
      ))}
    </ul>
  );
}

function ReportCard(detail: WorkbenchTaskDetail): Html | null {
  const { artifact, action, task } = detail;
  if (artifact === null) {
    if (!liveStatuses.includes(task.status)) return null;
    return (
      <section class="card report" aria-label="Draft report loading" aria-busy="true">
        <div class="report-body">
          <div class="skeleton skeleton-title"></div>
          <div class="skeleton skeleton-line"></div>
          <div class="skeleton skeleton-line"></div>
          <div class="skeleton skeleton-line"></div>
          <p class="subtle">The draft appears here once the model has analysed the evidence.</p>
        </div>
      </section>
    );
  }
  const { report, model } = artifact;
  const published = action?.status === 'succeeded';
  return (
    <section class="card report" id="report" aria-labelledby="report-title">
      <div class="report-head">
        <div class="stack-sm">
          <div class="row">
            {published ? (
              <span class="badge badge-sim">Published to Simulated Google Docs</span>
            ) : (
              <span class="badge badge-neutral">Draft, not published</span>
            )}
            {model.mode === 'stub' ? (
              <span class="badge badge-stub">STUB MODEL OUTPUT</span>
            ) : (
              <span class="badge badge-model">Generated by {model.modelId}</span>
            )}
          </div>
          <h2 id="report-title">{report.title}</h2>
        </div>
      </div>
      <div class="report-body" id="report-body">
        {reportSections(report)
          .filter((section) => section.items.length > 0)
          .map((section) => (
            <section>
              <h3>{section.heading}</h3>
              {ReportItems(section)}
            </section>
          ))}
      </div>
      <div class="report-foot">
        <button class="btn btn-sm" type="button" data-copy="#report-body" hidden>
          {Icon({ name: 'copy', small: true })} <span data-label="true">Copy report</span>
        </button>
        <a class="btn btn-sm" href={`/tasks/${task.id}/report.md`} download>
          {Icon({ name: 'download', small: true })} Download Markdown
        </a>
        <div class="model-meta" data-model-meta="true">
          <span>Mode: {model.mode}</span>
          <span>Model: {model.modelVersion}</span>
          <span>Latency: {duration(model.latencyMs)}</span>
          {model.responseId === null ? null : (
            <span>
              Response ID: <span class="mono">{model.responseId}</span>
            </span>
          )}
          {artifact.droppedCitations > 0 ? (
            <span>{artifact.droppedCitations} unsupported citation(s) removed</span>
          ) : (
            <span>All citations verified against retrieved sources</span>
          )}
        </div>
      </div>
    </section>
  );
}

type TaskCommand = 'cancel' | 'retry' | 'reconcile';

const commandButton: Record<
  TaskCommand,
  { readonly label: string; readonly tone: string; readonly icon: IconName }
> = {
  cancel: { label: 'Cancel task', tone: 'btn-danger', icon: 'x' },
  retry: { label: 'Retry', tone: 'btn-primary', icon: 'refresh' },
  reconcile: { label: 'Reconcile', tone: 'btn-primary', icon: 'refresh' },
};

function CommandForm(taskId: string, csrf: string, command: TaskCommand): Html {
  // eslint-disable-next-line security/detect-object-injection
  const button = commandButton[command];
  return (
    <form method="post" action={`/tasks/${taskId}/${command}`} data-once="true">
      <input type="hidden" name="csrf" value={csrf} />
      <button class={`btn btn-sm ${button.tone}`} type="submit">
        <span class="spinner" aria-hidden="true"></span>
        {Icon({ name: button.icon, small: true })} {button.label}
      </button>
    </form>
  );
}

function ProgressBubble(detail: WorkbenchTaskDetail, csrf: string): Html {
  const { task } = detail;
  const latest = detail.events.at(-1)?.summary ?? 'Queued';
  return (
    <div class="bubble stack-sm">
      <p class="progress-line">
        <span class="spinner" aria-hidden="true"></span>
        <span data-progress="true">{latest}</span>
      </p>
      {task.status === 'queued' || task.status === 'running' ? (
        <div class="row">{CommandForm(task.id, csrf, 'cancel')}</div>
      ) : null}
    </div>
  );
}

function ApprovalBubble(detail: WorkbenchTaskDetail, csrf: string): Html {
  const { task, evidence } = detail;
  return (
    <div class="bubble stack-sm">
      <p>
        I reviewed {evidence.length} source{evidence.length === 1 ? '' : 's'} and drafted the report
        below. Nothing has been written. Review the proposed document write and approve or reject
        it.
      </p>
      <div class="row">
        <a class="btn btn-sm btn-primary" href="#approval">
          Review approval
        </a>
        {CommandForm(task.id, csrf, 'cancel')}
      </div>
    </div>
  );
}

function CompletedAlert(detail: WorkbenchTaskDetail): Html {
  const link = detail.action?.externalUrl ?? null;
  return Alert(
    'ok',
    'Document created (simulated)',
    [
      'The approved report was written once to Simulated Google Docs. No real Google Workspace document exists.',
    ],
    link === null ? undefined : (
      <a class="btn btn-sm" href={safeWorkbenchUrl(link) ?? undefined} data-result-link="true">
        {Icon({ name: 'external', small: true })} Open simulated document
      </a>
    ),
    'status',
  );
}

function UncertainAlert(detail: WorkbenchTaskDetail, csrf: string): Html {
  const { task } = detail;
  return Alert(
    'warn',
    'Write outcome uncertain',
    [
      task.errorMessage ?? 'The document service did not confirm the write.',
      'Reconcile checks for the document first and only retries the same idempotent write if it is missing.',
    ],
    CommandForm(task.id, csrf, 'reconcile'),
    'alert',
  );
}

function FailedAlert(detail: WorkbenchTaskDetail, csrf: string): Html {
  const { task } = detail;
  return Alert(
    'danger',
    `Task failed: ${(task.errorCode ?? 'error').replaceAll('_', ' ')}`,
    [task.errorMessage ?? 'Something went wrong.'],
    h(
      Fragment,
      null,
      CommandForm(task.id, csrf, 'retry'),
      <a class="btn btn-sm" href="/">
        Start a new task
      </a>,
    ),
    'alert',
  );
}

const agentBody: Record<WorkbenchStatus, (detail: WorkbenchTaskDetail, csrf: string) => Html> = {
  queued: ProgressBubble,
  running: ProgressBubble,
  executing: ProgressBubble,
  cancel_requested: ProgressBubble,
  waiting_approval: ApprovalBubble,
  completed: CompletedAlert,
  declined: () =>
    Alert('info', 'Write rejected', [
      'You rejected the proposed document. Nothing was written. The draft stays below for reference.',
    ]),
  cancelled: () => Alert('info', 'Task cancelled', ['The task stopped. No document was written.']),
  outcome_uncertain: UncertainAlert,
  failed: FailedAlert,
};

function AgentTurn(detail: WorkbenchTaskDetail, csrf: string): Html {
  const { task } = detail;
  const body = agentBody[task.status](detail, csrf);
  return (
    <div class="turn turn-agent">
      <span class="turn-avatar" aria-hidden="true">
        AW
      </span>
      <div>
        <p class="turn-head">
          <strong>Agent Works</strong>
          <span>{task.llmMode === 'stub' ? 'stub model' : task.modelId}</span>
        </p>
        {body}
      </div>
    </div>
  );
}

function ApprovalPanel(
  approval: WorkbenchApproval,
  taskId: string,
  csrf: string,
  owner: string,
): Html {
  const { proposal } = approval;
  const decided = approval.state !== 'pending';
  return (
    <section
      class={`card panel approval${decided ? ` decided-${approval.state}` : ''}`}
      id="approval"
      aria-labelledby="approval-heading"
      tabindex="-1"
    >
      <div class="panel-head">
        <h2 id="approval-heading">
          {Icon({ name: 'shield' })}
          {decided ? 'Approval decision' : 'Approval required'}
        </h2>
        {SimBadge('Simulated write')}
      </div>
      <div class="panel-body stack">
        <dl class="kv">
          <dt>Action</dt>
          <dd>Create 1 Google Doc</dd>
          <dt>Destination</dt>
          <dd>{proposal.destination}</dd>
          <dt>Account</dt>
          <dd>{proposal.account}</dd>
          <dt>Requested by</dt>
          <dd>{owner} (task owner)</dd>
          <dt>Scope</dt>
          <dd>{proposal.scope}</dd>
          <dt>Document</dt>
          <dd>{proposal.documentTitle}</dd>
          <dt>Content</dt>
          <dd>
            {proposal.wordCount} words citing {proposal.sourceCount} source
            {proposal.sourceCount === 1 ? '' : 's'}
          </dd>
          <dt>Fingerprint</dt>
          <dd class="mono">{approval.payloadSha256.slice(0, 16)}</dd>
          <dt>Expires</dt>
          <dd>{Time(approval.expiresAt)}</dd>
        </dl>
        <div>
          <h3 class="subtle">Content preview</h3>
          <pre class="preview" tabindex="0" aria-label="Document content preview">
            {proposal.contentPreview}
          </pre>
        </div>
        <div>
          <h3 class="subtle">Risks</h3>
          <ul class="risks">
            {proposal.risks.map((risk) => (
              <li>{risk}</li>
            ))}
          </ul>
        </div>
        {decided ? DecisionReceipt(approval) : DecisionForms(taskId, csrf, approval)}
      </div>
    </section>
  );
}

function DecisionReceipt(approval: WorkbenchApproval): Html {
  const verdict =
    approval.state === 'approved'
      ? 'Approved'
      : approval.state === 'rejected'
        ? 'Rejected'
        : 'Voided because the task was cancelled';
  return (
    <p class="receipt" data-decision={approval.state} role="status">
      {Icon({ name: approval.state === 'approved' ? 'check' : 'x' })}
      <span>
        {verdict}
        {approval.decidedAt === null ? '' : ' by '}
        {approval.decidedBy ?? ''}
        {approval.decidedAt === null ? null : h(Fragment, null, ' at ', Time(approval.decidedAt))}.
        This decision is final.
      </span>
    </p>
  );
}

function DecisionForms(taskId: string, csrf: string, approval: WorkbenchApproval): Html {
  return (
    <div>
      <p class="subtle">
        Approving runs exactly one write. Retries reuse the same idempotency key, so the document
        cannot be duplicated.
      </p>
      <div class="decision-actions">
        <form method="post" action={`/tasks/${taskId}/approval`} data-once="true">
          <input type="hidden" name="csrf" value={csrf} />
          <input type="hidden" name="decision" value="approve" />
          <input type="hidden" name="expectedPayloadSha256" value={approval.payloadSha256} />
          <button class="btn btn-approve" type="submit">
            <span class="spinner" aria-hidden="true"></span>
            {Icon({ name: 'check', small: true })} Approve and create
          </button>
        </form>
        <form method="post" action={`/tasks/${taskId}/approval`} data-once="true">
          <input type="hidden" name="csrf" value={csrf} />
          <input type="hidden" name="decision" value="reject" />
          <input type="hidden" name="expectedPayloadSha256" value={approval.payloadSha256} />
          <button class="btn btn-danger" type="submit">
            <span class="spinner" aria-hidden="true"></span>
            {Icon({ name: 'x', small: true })} Reject
          </button>
        </form>
      </div>
    </div>
  );
}

export function TaskLive(detail: WorkbenchTaskDetail, csrf: string, notice?: string): Html {
  const { task, artifact, approval, evidence, events } = detail;
  const cited = artifact === null ? new Set<string>() : citedEvidenceIds(artifact.report);
  const owner = approval?.proposal.account ?? 'you';
  return (
    <>
      <div class="page-head">
        <div>
          {Breadcrumbs([{ label: 'Tasks', href: '/tasks' }, { label: task.title }])}
          <h1 id="task-title">{task.title}</h1>
          <p class="row subtle">
            {StatusPill(task.status)}
            <span>Created {Time(task.createdAt)}</span>
            <span class={`badge ${task.llmMode === 'stub' ? 'badge-stub' : 'badge-model'}`}>
              {modelLabel(task.llmMode, task.modelId, 'STUB MODEL')}
            </span>
          </p>
        </div>
      </div>
      {notice === undefined
        ? null
        : Alert('warn', 'That action did not go through', [notice], undefined, 'alert')}
      <nav class="jump" aria-label="Task sections">
        {artifact === null ? null : (
          <a class="btn btn-sm" href="#report">
            Report
          </a>
        )}
        {approval === null ? null : (
          <a class="btn btn-sm" href="#approval">
            Approval
          </a>
        )}
        <a class="btn btn-sm" href="#activity">
          Activity
        </a>
        <a class="btn btn-sm" href="#evidence">
          Evidence ({evidence.length})
        </a>
      </nav>
      <div class="task-layout">
        <div>
          <section aria-label="Conversation">
            <div class="turn turn-user">
              <span class="turn-avatar" aria-hidden="true">
                You
              </span>
              <div>
                <p class="turn-head">
                  <strong>You</strong>
                  {Time(task.createdAt)}
                </p>
                <div class="bubble">{task.objective}</div>
              </div>
            </div>
            {AgentTurn(detail, csrf)}
            <p class="oneshot-note">
              {Icon({ name: 'info', small: true })}
              <span>
                Each task runs once from its objective. Follow-up messages are not supported yet;
                start a new task to refine the request.
              </span>
            </p>
          </section>
          {ReportCard(detail)}
        </div>
        <aside class="task-aside" aria-label="Task context">
          {approval === null ? null : ApprovalPanel(approval, task.id, csrf, owner)}
          <section
            class="card panel"
            id="activity"
            aria-labelledby="activity-heading"
            tabindex="-1"
          >
            <div class="panel-head">
              <h2 id="activity-heading">{Icon({ name: 'clock' })} Activity</h2>
              <span class="subtle">{events.length} events</span>
            </div>
            <div class="panel-body">{Timeline(events)}</div>
          </section>
          <section
            class="card panel"
            id="evidence"
            aria-labelledby="evidence-heading"
            tabindex="-1"
          >
            <div class="panel-head">
              <h2 id="evidence-heading">{Icon({ name: 'search' })} Evidence</h2>
              {SimBadge('Fixture Drive')}
            </div>
            <div class="panel-body">
              {evidence.length === 0 ? (
                <p class="muted">
                  {liveStatuses.includes(task.status)
                    ? 'Sources appear here as soon as retrieval finishes.'
                    : 'No sources were retrieved for this task.'}
                </p>
              ) : (
                EvidenceList(evidence, cited)
              )}
            </div>
          </section>
        </aside>
      </div>
    </>
  );
}

export function TaskPage(detail: WorkbenchTaskDetail, csrf: string, notice?: string): Html {
  return (
    <div
      id="task-live"
      data-task-id={detail.task.id}
      data-version={String(detail.task.version)}
      data-status={detail.task.status}
      data-status-label={statusLabel(detail.task.status)}
      data-poll={liveStatuses.includes(detail.task.status) ? 'true' : 'false'}
    >
      {TaskLive(detail, csrf, notice)}
    </div>
  );
}

export function reportMarkdown(detail: WorkbenchTaskDetail): string {
  const artifact = detail.artifact;
  if (artifact === null) return '';
  const { report, model } = artifact;
  const cite = (ids: readonly string[]) => (ids.length === 0 ? '' : ` [${ids.join(', ')}]`);
  const line = (section: ReportSection, item: ReportItem): string =>
    section.kind === 'summary'
      ? item.text
      : `- ${item.title === undefined ? '' : `**${item.title}**: `}${item.text}${cite(item.evidenceIds)}`;
  // Empty sections keep their heading in the export, except gaps, which only appear when present.
  const sections = reportSections(report).filter(
    (section) => section.kind !== 'gaps' || section.items.length > 0,
  );
  const sources = detail.evidence.map((item) => `- ${item.id}: ${item.title} (${item.provenance})`);
  return [
    `# ${report.title}`,
    '',
    `> ${detail.action?.status === 'succeeded' ? 'Published to Simulated Google Docs' : 'Draft, not published'}. Generated by ${model.mode === 'stub' ? 'the offline stub model' : model.modelId}.`,
    ...sections.flatMap((section) => [
      '',
      `## ${section.heading}`,
      '',
      ...section.items.map((item) => line(section, item)),
    ]),
    '',
    '## Sources',
    '',
    ...sources,
    '',
  ].join('\n');
}
