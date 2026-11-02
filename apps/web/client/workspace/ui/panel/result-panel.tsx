// Result review: Result, Sources and Changes for one revision, with exact citation navigation.

import { useEffect, useState } from 'preact/hooks';

import {
  approvalRoute,
  backToResultRoute,
  citationRoute,
  resultRoute,
  withRevision,
  withView,
} from '../../store/panel-routes.js';
import { publishAvailability } from '../../store/publish-availability.js';
import { taskEntry } from '../../store/task-state.js';
import { Chip, ErrorLine, Who, sourceLabel, useCommand } from '../cards/bits.jsx';
import { useWorkspace } from '../context.js';
import { safeHref } from '../markdown-parse.js';
import { Markdown } from '../markdown.js';

import { Calculations } from './calculations.jsx';
import { Facts, TaskGate, externalHref } from './task-gate.jsx';

import type { TaskDetailPage } from '../../../../shared/contract.js';
import type { PanelRoute } from '../../../../shared/route.js';
import type { ResultView } from '../../store/panel-routes.js';
import type {
  CapabilityState,
  EvidenceView,
  RevisionDiff,
  RevisionView,
  Statement,
} from '@agent-works/domain/teamwork';
import type { JSX } from 'preact';

type ResultRoute = Extract<PanelRoute, { kind: 'result' }>;

const VIEWS: readonly { readonly id: ResultView; readonly label: string }[] = [
  { id: 'result', label: 'Result' },
  { id: 'sources', label: 'Sources' },
  { id: 'changes', label: 'Changes' },
];

const CITATION = /\[(E\d{1,3})\]/g;
const PLANNED_SECTION = /test|verif|validat/i;

const dateOf = (iso: string): string =>
  new Date(iso).toLocaleString([], {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });

function Cite(props: { readonly id: string; readonly onCite: (id: string, event: Event) => void }) {
  return (
    <button
      type="button"
      class="cite"
      aria-label={`Open source ${props.id}`}
      onClick={(event) => props.onCite(props.id, event)}
    >
      {props.id}
    </button>
  );
}

/** Statement text with each [E#] turned into a citation button; uncited evidence ids follow. */
function StatementLine(props: {
  readonly statement: Statement;
  readonly planned: boolean;
  readonly onCite: (id: string, event: Event) => void;
}): JSX.Element {
  const { statement } = props;
  const parts: (string | JSX.Element)[] = [];
  const seen = new Set<string>();
  let cursor = 0;
  for (const m of statement.text.matchAll(CITATION)) {
    parts.push(
      statement.text.slice(cursor, m.index),
      <Cite key={`${m.index}`} id={m[1]} onCite={props.onCite} />,
    );
    seen.add(m[1]);
    cursor = m.index + m[0].length;
  }
  parts.push(statement.text.slice(cursor));
  const rest = statement.evidenceIds.filter((id) => !seen.has(id));
  return (
    <li class="stmt" data-kind={statement.kind} data-support={statement.support}>
      {props.planned ? <Chip tone="muted">Planned</Chip> : null}
      {statement.kind === 'hypothesis' || statement.kind === 'assumption' ? (
        <Chip tone="attention">{statement.kind}</Chip>
      ) : null}
      <span class="stmt-text">{parts}</span>
      {rest.map((id) => (
        <Cite key={id} id={id} onCite={props.onCite} />
      ))}
      {statement.calculationIds.map((id) => (
        <span key={id} class="calc-ref">
          {id}
        </span>
      ))}
      {statement.support === 'unsupported' ? <Chip tone="error">Unsupported</Chip> : null}
    </li>
  );
}

function ResultBody(props: {
  readonly detail: TaskDetailPage;
  readonly revision: RevisionView;
  readonly onCite: (id: string, event: Event) => void;
}): JSX.Element {
  const { detail, revision } = props;
  const engineering = detail.task.workflow === 'engineering_proposal';
  return (
    <div class="result">
      {engineering ? (
        <p class="note" role="note">
          Proposal only. Nothing was changed in the repository, and tests listed here are planned,
          not run.
        </p>
      ) : null}
      <Markdown text={revision.content.summary} />
      <Calculations calculations={revision.calculations} />
      {revision.content.sections.map((section) => (
        <section key={section.heading} class="result-section">
          <h4>{section.heading}</h4>
          <ul class="stmts">
            {section.statements.map((statement, i) => (
              <StatementLine
                key={i}
                statement={statement}
                planned={engineering && PLANNED_SECTION.test(section.heading)}
                onCite={props.onCite}
              />
            ))}
          </ul>
        </section>
      ))}
      {revision.content.limitations.length === 0 &&
      revision.missingAssignments.length === 0 ? null : (
        <section class="result-section result-limits">
          <h4>Limitations and uncertainties</h4>
          <ul>
            {revision.missingAssignments.map((key) => (
              <li key={`m:${key}`}>Contribution {key} did not finish and is not reflected here.</li>
            ))}
            {revision.content.limitations.map((text, i) => (
              <li key={i}>
                <Markdown text={text} />
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}

function Evidence(props: { readonly entry: EvidenceView; readonly cited: boolean }): JSX.Element {
  const { entry, cited } = props;
  const href = entry.url === null ? undefined : safeHref(entry.url);
  return (
    <li class="ev" id={`ev-${entry.id}`} aria-current={cited ? 'true' : undefined} tabIndex={-1}>
      <div class="ev-head">
        <span class="ev-id">{entry.id}</span>
        <span class="ev-title">{entry.title}</span>
        <Chip tone="muted">{sourceLabel(entry.sourceKind)}</Chip>
        {entry.stale ? <Chip tone="attention">Source changed since</Chip> : null}
      </div>
      <p class="muted ev-where">
        {entry.provenance} · {entry.location}
        {entry.modifiedAt === null ? '' : ` · updated ${dateOf(entry.modifiedAt)}`}
      </p>
      <blockquote class={cited ? 'ev-excerpt ev-hit' : 'ev-excerpt'}>
        {cited ? <mark>{entry.excerpt}</mark> : entry.excerpt}
      </blockquote>
      {href === undefined ? null : (
        <a class="md-link" href={href} rel="noopener noreferrer" target="_blank">
          Open source
        </a>
      )}
    </li>
  );
}

function SourcesBody(props: {
  readonly detail: TaskDetailPage;
  readonly revision: RevisionView;
  readonly citation: string | null;
  readonly onBack: (event: Event) => void;
}): JSX.Element {
  const { detail, revision, citation } = props;
  const ids = new Set(revision.evidenceIds);
  const entries = ids.size === 0 ? detail.evidence : detail.evidence.filter((e) => ids.has(e.id));
  const found = citation === null ? undefined : entries.find((e) => e.id === citation);
  useEffect(() => {
    if (citation === null) return;
    const node = document.getElementById(`ev-${citation}`);
    node?.scrollIntoView({ block: 'center' });
    node?.focus({ preventScroll: true });
  }, [citation, revision.revision]);
  return (
    <div class="sources">
      {citation === null ? null : (
        <div class="sources-back">
          <button type="button" class="btn btn-quiet btn-sm" onClick={props.onBack}>
            <span aria-hidden="true">← </span>Back to result
          </button>
          {found === undefined ? (
            <span role="alert">{citation} is not among this revision's sources.</span>
          ) : null}
        </div>
      )}
      {entries.length === 0 ? <p class="muted">This revision cites no sources.</p> : null}
      <ul class="ev-list">
        {entries.map((entry) => (
          <Evidence key={entry.id} entry={entry} cited={entry.id === citation} />
        ))}
      </ul>
    </div>
  );
}

const listOrNone = (items: readonly string[]): string =>
  items.length === 0 ? 'none' : items.join(', ');

function SourceChanges(props: { readonly diff: RevisionDiff }): JSX.Element | null {
  const { diff } = props;
  if (diff.sourcesAdded.length === 0 && diff.sourcesRemoved.length === 0) return null;
  return (
    <Facts
      rows={[
        ['Sources added', listOrNone(diff.sourcesAdded)],
        ['Sources removed', listOrNone(diff.sourcesRemoved)],
      ]}
    />
  );
}

const emptyDiff = (diff: RevisionDiff): boolean =>
  [diff.added, diff.removed, diff.sourcesAdded, diff.sourcesRemoved].every((l) => l.length === 0);

function ChangesBody(props: { readonly revision: RevisionView }): JSX.Element {
  const { revision } = props;
  const diff = revision.diff;
  if (revision.parent === null || diff === null)
    return <p class="muted">First revision. There is nothing earlier to compare with.</p>;
  const empty = emptyDiff(diff);
  return (
    <div class="changes">
      <p class="muted">
        Revision {revision.parent} → revision {revision.revision}
        {revision.request === null ? '' : ` · asked: ${revision.request}`}
      </p>
      {empty ? <p>No content or source changes between these revisions.</p> : null}
      {diff.changedSections.length === 0 ? null : (
        <p>
          Changed sections: <strong>{diff.changedSections.join(', ')}</strong>
        </p>
      )}
      <ul class="diff">
        {diff.added.map((line, i) => (
          <li key={`a${i}`} class="diff-add">
            <span class="diff-sign" aria-label="Added">
              +
            </span>
            <span class="muted">{line.heading}</span> {line.text}
          </li>
        ))}
        {diff.removed.map((line, i) => (
          <li key={`r${i}`} class="diff-del">
            <span class="diff-sign" aria-label="Removed">
              −
            </span>
            <span class="muted">{line.heading}</span> {line.text}
          </li>
        ))}
      </ul>
      <SourceChanges diff={diff} />
    </div>
  );
}

function Published(props: { readonly detail: TaskDetailPage; readonly revision: number }) {
  const { store } = useWorkspace();
  const segment = store.state.value.scope.segment;
  const done = props.detail.approvals.find(
    (a) => a.proposal.revision === props.revision && a.action?.status === 'succeeded',
  );
  if (done === undefined) return <Chip tone="muted">Draft · no external change</Chip>;
  const href = externalHref(segment, done.action?.externalUrl ?? null);
  return (
    <Chip tone="ok">
      Published to {done.proposal.destination}
      {href === undefined ? null : (
        <>
          {' · '}
          <a href={href}>open document</a>
        </>
      )}
    </Chip>
  );
}

/** The result owner's effective capabilities, fetched once per owner; undefined while loading. */
function useOwnerCapabilities(ownerId: string): readonly CapabilityState[] | undefined {
  const { effects } = useWorkspace();
  const [loaded, setLoaded] = useState<{
    readonly id: string;
    readonly capabilities: readonly CapabilityState[];
  }>();
  useEffect(() => {
    let live = true;
    effects.identity
      .detail(ownerId)
      .then((detail) => {
        if (live) setLoaded({ id: ownerId, capabilities: detail.capabilities });
      })
      .catch(() => {
        if (live) setLoaded({ id: ownerId, capabilities: [] });
      });
    return () => {
      live = false;
    };
  }, [ownerId, effects]);
  return loaded?.id === ownerId ? loaded.capabilities : undefined;
}

/**
 * Requests a publication of this revision. Nothing is written here: the segment prepares an
 * approval the member reviews first, and on the demo stack the destination is the fixture store.
 */
function Publish(props: {
  readonly detail: TaskDetailPage;
  readonly revision: number;
}): JSX.Element {
  const { store, effects } = useWorkspace();
  const { detail, revision } = props;
  const me = store.state.value.me;
  const demo = me.sourceMode === 'fixture';
  const capabilities = useOwnerCapabilities(detail.task.resultOwner);
  const command = useCommand(detail.task.id);
  const availability = publishAvailability({
    detail,
    revision,
    readOnly: me.readOnly,
    ownerCapabilities: capabilities,
  });
  const publish = async () => {
    const outcome = await command.run('publish', { revision });
    if (!outcome.ok) return;
    const fresh = taskEntry(store.peek().tasks, detail.task.id).detail;
    const approval = fresh?.approvals.find(
      (a) => a.state === 'pending' && a.proposal.revision === revision,
    );
    if (approval !== undefined)
      effects.open(approvalRoute(store.peek().route, detail.task.id, approval.id));
  };
  return (
    <div class="publish" data-available={availability.ok ? 'true' : 'false'}>
      <button
        type="button"
        class="btn btn-sm"
        disabled={!availability.ok || command.busy}
        aria-describedby="publish-note"
        onClick={() => void publish()}
      >
        {demo ? 'Publish to demo document store' : 'Publish as a Google Doc'}
      </button>
      <p id="publish-note" class="muted publish-note">
        {availability.ok
          ? `Revision ${revision}${demo ? ', demo only: a fixture document, no live Google Docs write' : ''}. Nothing is written until you review and approve it.`
          : availability.reason}
      </p>
      <ErrorLine text={command.error} />
    </div>
  );
}

function MissingRevision(props: {
  readonly taskId: string;
  readonly revision: number;
  readonly latest: number;
}): JSX.Element {
  const { store, effects } = useWorkspace();
  return (
    <div role="alert">
      <p>Revision {props.revision} is not available.</p>
      {props.latest > 0 ? (
        <button
          type="button"
          class="btn btn-quiet btn-sm"
          onClick={() => effects.open(resultRoute(store.peek().route, props.taskId, props.latest))}
        >
          Open revision {props.latest}
        </button>
      ) : null}
    </div>
  );
}

function RevisionPicker(props: {
  readonly detail: TaskDetailPage;
  readonly revision: number;
}): JSX.Element {
  const { store, effects } = useWorkspace();
  const latest = props.detail.task.latestRevision;
  return (
    <label class="rp-rev">
      <span class="visually-hidden">Revision</span>
      <select
        aria-label="Revision"
        value={String(props.revision)}
        onChange={(event) =>
          effects.open(withRevision(store.peek().route, Number(event.currentTarget.value)))
        }
      >
        {props.detail.revisions.map((r) => (
          <option key={r.revision} value={String(r.revision)}>
            Revision {r.revision}
            {r.revision === latest ? ' (latest)' : ''} · {dateOf(r.createdAt)}
          </option>
        ))}
      </select>
    </label>
  );
}

export function ResultPanel(props: { readonly panel: ResultRoute }): JSX.Element {
  const { store, effects } = useWorkspace();
  const { panel } = props;
  const route = () => store.peek().route;
  return (
    <TaskGate taskId={panel.taskId}>
      {(detail) => {
        const revision = detail.revisions.find((r) => r.revision === panel.revision);
        const latest = detail.task.latestRevision;
        if (revision === undefined)
          return (
            <MissingRevision taskId={panel.taskId} revision={panel.revision} latest={latest} />
          );
        const onCite = (id: string) => effects.open(citationRoute(route(), id));
        return (
          <div class="rp">
            <header class="rp-head">
              <h3 class="rp-title">{revision.content.title}</h3>
              <p class="rp-meta">
                <Who id={detail.task.resultOwner} name="Result owner" size={20} />
                <RevisionPicker detail={detail} revision={panel.revision} />
                <Published detail={detail} revision={panel.revision} />
              </p>
              {panel.revision === latest ? (
                <Publish detail={detail} revision={panel.revision} />
              ) : null}
              {panel.revision < latest ? (
                <p class="note">
                  You are reading revision {panel.revision} of {latest}.{' '}
                  <button
                    type="button"
                    class="link"
                    onClick={() => effects.open(withRevision(route(), latest))}
                  >
                    Open the latest
                  </button>
                </p>
              ) : null}
              <div class="tabs rp-tabs" role="tablist" aria-label="Result views">
                {VIEWS.map((view) => (
                  <button
                    key={view.id}
                    type="button"
                    role="tab"
                    id={`rp-tab-${view.id}`}
                    class="tab"
                    aria-selected={panel.view === view.id}
                    aria-controls="rp-view"
                    tabIndex={panel.view === view.id ? 0 : -1}
                    onClick={() => effects.open(withView(route(), view.id))}
                    onKeyDown={(event) => {
                      const i = VIEWS.findIndex((v) => v.id === panel.view);
                      const next =
                        event.key === 'ArrowRight'
                          ? VIEWS[(i + 1) % VIEWS.length]
                          : event.key === 'ArrowLeft'
                            ? VIEWS[(i + VIEWS.length - 1) % VIEWS.length]
                            : undefined;
                      if (next === undefined) return;
                      event.preventDefault();
                      effects.open(withView(route(), next.id));
                      document.getElementById(`rp-tab-${next.id}`)?.focus();
                    }}
                  >
                    {view.label}
                  </button>
                ))}
              </div>
            </header>
            <div id="rp-view" role="tabpanel" aria-labelledby={`rp-tab-${panel.view}`}>
              {panel.view === 'result' ? (
                <ResultBody detail={detail} revision={revision} onCite={onCite} />
              ) : panel.view === 'sources' ? (
                <SourcesBody
                  detail={detail}
                  revision={revision}
                  citation={panel.citation}
                  onBack={() => effects.open(backToResultRoute(route()))}
                />
              ) : (
                <ChangesBody revision={revision} />
              )}
            </div>
          </div>
        );
      }}
    </TaskGate>
  );
}
