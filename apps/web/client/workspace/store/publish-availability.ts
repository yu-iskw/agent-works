// Whether the result panel may offer "Publish" for the revision it shows. The segment makes the
// same checks in preparePublish; this mirror keeps the control honest before the request leaves.

import type { TaskDetailPage } from '../../../shared/contract.js';
import type { CapabilityState } from '@agent-works/domain/teamwork';

export type PublishAvailability =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: string; readonly pending: boolean };

export type PublishInput = {
  readonly detail: TaskDetailPage;
  readonly revision: number;
  /** The member's entitlement as the segment reports it; read-only members never publish. */
  readonly readOnly: boolean;
  /** The result owner's effective capabilities, or undefined while they are still loading. */
  readonly ownerCapabilities: readonly CapabilityState[] | undefined;
};

const PUBLISHABLE = new Set<TaskDetailPage['task']['status']>(['ready', 'completed']);

const refuse = (reason: string, pending = false): PublishAvailability => ({
  ok: false,
  reason,
  pending,
});

export function publishAvailability(input: PublishInput): PublishAvailability {
  const { detail, revision } = input;
  const latest = detail.task.latestRevision;
  if (revision !== latest)
    return refuse(`Only the latest revision (${latest}) can be published. Open it to publish.`);
  if (input.readOnly) return refuse('Your membership is read-only, so nothing can be published.');
  const pending = detail.approvals.find((a) => a.state === 'pending');
  if (pending !== undefined)
    return refuse(
      pending.proposal.revision === revision
        ? 'An approval for this revision is already waiting for your decision.'
        : `An approval for revision ${pending.proposal.revision} is still pending.`,
    );
  const published = detail.approvals.find(
    (a) => a.proposal.revision === revision && a.action?.status === 'succeeded',
  );
  if (published !== undefined)
    return refuse(`Revision ${revision} is already published; a second copy is never created.`);
  if (!PUBLISHABLE.has(detail.task.status))
    return refuse('The task must be ready or completed before a result can be published.');
  if (input.ownerCapabilities === undefined)
    return refuse('Checking what the result owner may do…', true);
  const docs = input.ownerCapabilities.find((c) => c.capability === 'docs.publish');
  if (docs === undefined || !docs.effective)
    return refuse(
      docs?.reason ?? 'The result owner has no effective docs.publish capability in this segment.',
    );
  return { ok: true };
}
