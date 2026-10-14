import { canonicalPayloadSha256 } from '@agent-works/domain';

import {
  docsDraftSchema,
  calendarCreateSchema,
  gmailDraftSchema,
} from '../../../../packages/domain/dist/workspace-tools.js';
import { h } from '../html.js';

import { WorkspaceApprovalCard } from './workspace-card.js';

import type { WorkspaceApprovalPayload } from './workspace-card.js';
import type { Html } from '../html.js';
import type { Approval } from '@agent-works/domain';
export type WorkspacePageView = {
  readonly approval: Approval;
  readonly payload: unknown;
  readonly csrfToken: string;
  readonly now: Date;
  readonly message?: string;
};
export function workspacePage(view: WorkspacePageView): Html {
  if (canonicalPayloadSha256(view.payload) !== view.approval.payloadSha256)
    throw new Error('payload mismatch');
  const payload = cardPayload(view.approval.tool, view.payload);
  const card = WorkspaceApprovalCard({ payload, payloadSha256: view.approval.payloadSha256 });
  const pending = view.approval.state === 'pending';
  const expired = Date.parse(view.approval.expiresAt) <= view.now.getTime();
  return (
    <main>
      <h1>Review workspace approval</h1>
      <p>Requested by {view.approval.requestedBySub}</p>
      <p>State: {view.approval.state}</p>
      {card}
      {view.message && <p role="status">{view.message}</p>}
      {expired && pending && <p role="alert">This approval has expired.</p>}
      {pending && !expired && (
        <form
          method="post"
          action={`/approvals/workspace/${encodeURIComponent(view.approval.id)}/decide`}
        >
          <input type="hidden" name="csrfToken" value={view.csrfToken} />
          <input type="hidden" name="expectedPayloadSha256" value={view.approval.payloadSha256} />
          <button type="submit" name="decision" value="approve">
            Approve
          </button>
          <button type="submit" name="decision" value="reject">
            Reject
          </button>
        </form>
      )}
    </main>
  );
}
function cardPayload(tool: string, payload: unknown): WorkspaceApprovalPayload {
  switch (tool) {
    case 'docs.createDraft@1.0.0':
      return { tool: 'docs.createDraft', ...docsDraftSchema.parse(payload) };
    case 'calendar.createEvent@1.0.0':
      return { tool: 'calendar.createEvent', ...calendarCreateSchema.parse(payload) };
    case 'gmail.createDraft@1.0.0':
      return { tool: 'gmail.createDraft', ...gmailDraftSchema.parse(payload) };
    default:
      throw new Error('unsupported approval');
  }
}
