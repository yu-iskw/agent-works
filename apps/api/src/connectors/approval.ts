import { randomUUID } from 'node:crypto';

import { approvalSchema } from '@agent-works/domain';

import {
  parseWorkspacePayload,
  workspacePayloadHash,
  workspaceTarget,
  workspaceToolRef,
} from '../../../../packages/domain/dist/workspace-tools.js';

import { ConnectorError } from './errors.js';

import type { WorkspaceCall } from './broker.js';
import type { ApprovalStore } from '../broker/approvals.js';
/** Prepare once, persist the exact normalized payload, then request a human decision. */
export async function prepareWorkspaceApproval(
  store: ApprovalStore,
  input: WorkspaceCall,
  now: Date,
) {
  if (!['docs.createDraft', 'calendar.createEvent', 'gmail.createDraft'].includes(input.tool))
    throw new ConnectorError('POLICY_DENIED', 403);
  const payload = parseWorkspacePayload(input.tool, input.payload);
  const approval = approvalSchema.parse({
    id: randomUUID(),
    taskId: input.taskId,
    stepId: input.stepId,
    tool: workspaceToolRef(input.tool),
    targetResource: workspaceTarget(input.tool, payload),
    payloadSha256: workspacePayloadHash(input.tool, payload),
    requestedBySub: input.subject,
    approverSub: null,
    state: 'pending',
    expiresAt: new Date(now.getTime() + 300_000).toISOString(),
    maxExecutions: 1,
    executionsUsed: 0,
  });
  await store.save(approval);
  await store.savePayload(approval.id, payload);
  return { approval, payload };
}
