import { Fragment, h } from '../html.js';

import type { Html } from '../html.js';
import type { ApprovalDetail } from './reader.js';
import type { Approval } from '@agent-works/domain';

export type ApprovalView = {
  readonly approval: Approval | ApprovalDetail;
  readonly csrfToken: string;
  readonly message?: string;
  readonly blocked?: boolean;
};

export default function Page({ approval, csrfToken, message, blocked }: ApprovalView): Html {
  const pending = approval.state === 'pending';
  const expired = Date.parse(approval.expiresAt) <= Date.now();
  return (
    <main>
      <h1>Review approval</h1>
      <p>Review the exact action before approving or rejecting it.</p>
      <dl>
        <dt>Approval</dt>
        <dd>{approval.id}</dd>
        {'kind' in approval ? (
          <>
            <dt>Action</dt>
            <dd>{approval.actionSummary}</dd>
          </>
        ) : (
          <>
            <dt>Task</dt>
            <dd>{approval.taskId}</dd>
            <dt>Step</dt>
            <dd>{approval.stepId}</dd>
            <dt>Tool</dt>
            <dd>{approval.tool}</dd>
            <dt>Target resource</dt>
            <dd>{approval.targetResource}</dd>
          </>
        )}
        <dt>Requested by</dt>
        <dd>{approval.requestedBySub}</dd>
        <dt>Payload SHA-256</dt>
        <dd>
          <code>{approval.payloadSha256}</code>
        </dd>
        <dt>Expires</dt>
        <dd>
          <time datetime={approval.expiresAt}>{approval.expiresAt}</time>
        </dd>
        <dt>State</dt>
        <dd>{approval.state}</dd>
        {!('kind' in approval) && (
          <>
            <dt>Executions</dt>
            <dd>
              {approval.executionsUsed} / {approval.maxExecutions}
            </dd>
          </>
        )}
      </dl>
      {message !== undefined && <p role={blocked === true ? 'alert' : 'status'}>{message}</p>}
      {expired && pending && <p role="alert">This approval has expired.</p>}
      {pending && !expired && blocked !== true && (
        <form method="post" action={`/approvals/${encodeURIComponent(approval.id)}/decide`}>
          <input type="hidden" name="csrfToken" value={csrfToken} />
          <input type="hidden" name="expectedPayloadSha256" value={approval.payloadSha256} />
          <button type="submit" name="decision" value="approve">
            Approve
          </button>
          <button type="submit" name="decision" value="reject">
            Reject
          </button>
        </form>
      )}
      {blocked === true && (
        <a href={`/approvals/${encodeURIComponent(approval.id)}`}>Reload approval</a>
      )}
    </main>
  );
}
