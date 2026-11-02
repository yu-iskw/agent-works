// Action approval: exactly what would be written, where, from which revision, and whether this
// approval can still do it. The decision bar stays visible on a phone.

import { resultRoute } from '../../store/panel-routes.js';
import { Chip, ErrorLine, useCommand, useOpen } from '../cards/bits.jsx';
import { useWorkspace } from '../context.js';
import { Markdown } from '../markdown.js';

import { Facts, TaskGate, externalHref } from './task-gate.jsx';

import type { TaskDetailPage } from '../../../../shared/contract.js';
import type { PanelRoute } from '../../../../shared/route.js';
import type { ActionApprovalView } from '@agent-works/domain/teamwork';
import type { JSX } from 'preact';

type ApprovalRoute = Extract<PanelRoute, { kind: 'approval' }>;

type Validity =
  | { readonly ok: true }
  | {
      readonly ok: false;
      /** The short status the chip shows, so it never reads "pending" for an unusable approval. */
      readonly label: string;
      readonly reason: string;
      readonly tone: 'muted' | 'error';
    };

/** The same checks decideAction makes, so the panel never offers an approval the segment refuses. */
function validity(detail: TaskDetailPage, approval: ActionApprovalView, now: number): Validity {
  if (approval.state !== 'pending')
    return {
      ok: false,
      label: approval.state,
      reason: `Already ${approval.state}.`,
      tone: 'muted',
    };
  if (approval.proposal.revision !== detail.task.latestRevision)
    return {
      ok: false,
      label: 'Stale: newer revision',
      reason: `Revision ${detail.task.latestRevision} replaced revision ${approval.proposal.revision}. This approval cannot write the newer content; request a new one from the latest result.`,
      tone: 'error',
    };
  if (Date.parse(approval.expiresAt) <= now)
    return {
      ok: false,
      label: 'Expired',
      reason: 'This approval expired before a decision was made.',
      tone: 'error',
    };
  return { ok: true };
}

const ACTION_STATUS: Readonly<Record<NonNullable<ActionApprovalView['action']>['status'], string>> =
  {
    intended: 'Approved. Creating the document…',
    succeeded: 'Document created.',
    failed: 'Creating the document failed.',
    uncertain: 'The document store did not confirm the write.',
  };

function Outcome(props: {
  readonly detail: TaskDetailPage;
  readonly approval: ActionApprovalView;
}): JSX.Element {
  const { store } = useWorkspace();
  const segment = store.state.value.scope.segment;
  const command = useCommand(props.detail.task.id);
  const { approval } = props;
  const action = approval.action;
  if (approval.state === 'rejected')
    return <Chip tone="muted">Denied. No document was created.</Chip>;
  if (approval.state === 'void')
    return <Chip tone="muted">Void. No document was created by this approval.</Chip>;
  if (action === null) return <Chip tone="attention">Approved; waiting for the publish job.</Chip>;
  const href = externalHref(segment, action.externalUrl);
  const tone =
    action.status === 'succeeded' ? 'ok' : action.status === 'intended' ? 'segment' : 'error';
  return (
    <div class="outcome">
      <Chip tone={tone}>{ACTION_STATUS[action.status]}</Chip>
      {action.status === 'succeeded' && href !== undefined ? (
        <p>
          <a href={href}>Open the document</a>
          {action.externalId === null ? null : <span class="muted"> · {action.externalId}</span>}
        </p>
      ) : null}
      {action.status === 'uncertain' ? (
        <p>
          A document may exist. Reconcile first; the publish is never repeated with a second key.{' '}
          <button
            type="button"
            class="btn btn-primary btn-sm"
            disabled={command.busy}
            onClick={() => void command.run('reconcile')}
          >
            Reconcile
          </button>
        </p>
      ) : null}
      {action.status === 'failed' ? (
        <button
          type="button"
          class="btn btn-primary btn-sm"
          disabled={command.busy}
          onClick={() => void command.run('retry')}
        >
          Retry publishing
        </button>
      ) : null}
      <ErrorLine text={command.error} />
    </div>
  );
}

function Decide(props: {
  readonly detail: TaskDetailPage;
  readonly approval: ActionApprovalView;
  readonly validity: Validity;
}): JSX.Element {
  const { approval } = props;
  const command = useCommand(props.detail.task.id);
  const disabled = !props.validity.ok || command.busy;
  const decide = (decision: 'approve' | 'reject') =>
    void command.run('action', {
      approvalId: approval.id,
      expectedDigest: approval.digest,
      decision,
    });
  return (
    <div class="pn-decide pn-decide-sticky">
      <p class="decide-facts">
        <span>{approval.proposal.account}</span>
        <span>{approval.proposal.destination}</span>
        <span>Revision {approval.proposal.revision}</span>
      </p>
      {props.validity.ok ? (
        <p class="note" role="status">
          <strong>Pending your approval.</strong> No document has been created.
        </p>
      ) : (
        <p class="note" role="status" data-tone={props.validity.tone}>
          {props.validity.reason}
        </p>
      )}
      <div class="pn-actions">
        <button
          type="button"
          class="btn btn-primary"
          disabled={disabled}
          onClick={() => decide('approve')}
        >
          Approve once
        </button>
        <button type="button" class="btn" disabled={disabled} onClick={() => decide('reject')}>
          Deny
        </button>
      </div>
      <ErrorLine text={command.error} />
    </div>
  );
}

export function ApprovalPanel(props: { readonly panel: ApprovalRoute }): JSX.Element {
  const { store } = useWorkspace();
  const open = useOpen();
  const demo = store.state.value.me.sourceMode === 'fixture';
  const { panel } = props;
  return (
    <TaskGate taskId={panel.taskId}>
      {(detail) => {
        const approval = detail.approvals.find((a) => a.id === panel.approvalId);
        if (approval === undefined)
          return <p role="alert">This approval is not available for this task.</p>;
        const valid = validity(detail, approval, Date.now());
        const { proposal } = approval;
        return (
          <div class="approval">
            <header class="rp-head">
              <h3 class="rp-title">Create a document: {proposal.documentTitle}</h3>
              <p class="rp-meta">
                <Chip tone={valid.ok ? 'attention' : valid.tone === 'error' ? 'error' : 'muted'}>
                  {valid.ok ? 'Pending your approval' : valid.label}
                </Chip>
                {demo ? <Chip tone="segment">Demo action · fixture document store</Chip> : null}
              </p>
            </header>
            <Facts
              rows={[
                ['Operation', 'google_docs.create'],
                ['Account', proposal.account],
                [
                  'Destination',
                  demo
                    ? `${proposal.destination} (fixture, no live Google Docs write)`
                    : proposal.destination,
                ],
                ['Title', proposal.documentTitle],
                [
                  'Revision',
                  `${proposal.revision}${detail.task.latestRevision !== proposal.revision ? ` (latest is ${detail.task.latestRevision})` : ' (latest)'}`,
                ],
                ['Length', `${proposal.wordCount} words`],
                ['Expires', new Date(approval.expiresAt).toLocaleString()],
              ]}
            />
            <p>
              <button
                type="button"
                class="btn btn-quiet btn-sm"
                onClick={(event) =>
                  open(
                    resultRoute(store.peek().route, detail.task.id, proposal.revision, 'sources'),
                    event,
                  )
                }
              >
                Sources for revision {proposal.revision}
              </button>
            </p>
            {proposal.consequences.length === 0 ? null : (
              <>
                <h4>Consequences</h4>
                <ul>
                  {proposal.consequences.map((c, i) => (
                    <li key={i}>{c}</li>
                  ))}
                </ul>
              </>
            )}
            <h4>Content preview (revision {proposal.revision})</h4>
            <div
              class="preview"
              role="region"
              aria-label={`Content preview, revision ${proposal.revision}`}
              tabIndex={0}
            >
              <Markdown text={proposal.contentMarkdown} />
            </div>
            {approval.state === 'pending' ? (
              <Decide detail={detail} approval={approval} validity={valid} />
            ) : (
              <Outcome detail={detail} approval={approval} />
            )}
          </div>
        );
      }}
    </TaskGate>
  );
}
