import { canonicalPayloadSha256 } from '@agent-works/domain';

import { beginWorkspaceStepUp } from '../credentials/flow.js';

import { prepareWorkspaceApproval } from './approval.js';
import { ConnectorError } from './errors.js';
import { callerRoute, workspaceBody } from './route-auth.js';
import {
  workspaceApprovalReadSchema,
  workspaceDecisionSchema,
  workspaceExecuteSchema,
  workspaceScopeRequestSchema,
} from './route-schema.js';

import type { WorkspaceBroker } from './broker.js';
import type { VerifyAssertion } from '../auth/iap.js';
import type { ApprovalStore } from '../broker/approvals.js';
import type { OAuthFlow } from '../credentials/flow.js';
import type { Route } from '../http.js';
import type { CredentialsPort } from '../ports/credentials.js';
export type WorkspaceRouteDeps = {
  readonly verify: VerifyAssertion;
  readonly broker: WorkspaceBroker;
  readonly approvals: ApprovalStore;
  readonly credentials: CredentialsPort;
  readonly flow: OAuthFlow;
  readonly now: () => Date;
  readonly approverAuthorized: (subject: string) => boolean;
  readonly authorizePreparation: (
    subject: string,
    taskId: string,
    tool: string,
  ) => Promise<boolean>;
};
/** Route factory uses the same trusted verifier as the task routes. No subject is
 * accepted in the command body. Explicit dependency injection enables offline use. */
export function workspaceRoutes(deps: WorkspaceRouteDeps): Readonly<Record<string, Route>> {
  return {
    'POST /v1/connectors/execute': callerRoute(deps.verify, async (subject, request) => {
      const input = workspaceExecuteSchema.parse(workspaceBody(request));
      const result = await deps.broker.execute({ ...input, subject });
      return { status: 200, body: result };
    }),
    'POST /v1/connectors/scopes': callerRoute(deps.verify, async (subject, request) => {
      const { tool, ...start } = workspaceScopeRequestSchema.parse(workspaceBody(request));
      return {
        status: 200,
        body: await beginWorkspaceStepUp(deps.flow, deps.credentials, subject, tool, start),
      };
    }),
    'POST /v1/connectors/approvals/prepare': callerRoute(deps.verify, async (subject, request) => {
      const input = workspaceExecuteSchema.parse(workspaceBody(request));
      if (!(await deps.authorizePreparation(subject, input.taskId, input.tool)))
        throw new ConnectorError('POLICY_DENIED', 403);
      const result = await prepareWorkspaceApproval(
        deps.approvals,
        { ...input, subject },
        deps.now(),
      );
      return { status: 201, body: result };
    }),
    'POST /v1/connectors/approvals/read': callerRoute(deps.verify, async (subject, request) => {
      const { approvalId } = workspaceApprovalReadSchema.parse(workspaceBody(request));
      const approval = await visibleApproval(deps, subject, approvalId);
      const payload = await deps.approvals.readPayload(approvalId);
      if (canonicalPayloadSha256(payload) !== approval.payloadSha256)
        throw new ConnectorError('APPROVAL_REQUIRED');
      return { status: 200, body: { approval, payload } };
    }),
    'POST /v1/connectors/approvals/decide': callerRoute(deps.verify, async (subject, request) => {
      if (!deps.approverAuthorized(subject)) throw new ConnectorError('POLICY_DENIED', 403);
      const { approvalId, ...command } = workspaceDecisionSchema.parse(workspaceBody(request));
      const approval = await visibleApproval(deps, subject, approvalId);
      if (command.expectedPayloadSha256 !== approval.payloadSha256)
        throw new ConnectorError('APPROVAL_REQUIRED');
      if (Date.parse(approval.expiresAt) <= deps.now().getTime())
        throw new ConnectorError('APPROVAL_EXPIRED');
      const result = await deps.approvals.bind(approvalId, { ...command, actorSub: subject });
      if (!result.ok) throw new ConnectorError('APPROVAL_REQUIRED');
      return { status: 200, body: result.decided };
    }),
  };
}
async function visibleApproval(deps: WorkspaceRouteDeps, subject: string, id: string) {
  const approval = await deps.approvals.read(id);
  if (!approval || (!deps.approverAuthorized(subject) && approval.requestedBySub !== subject))
    throw new ConnectorError('RESOURCE_DENIED', 403);
  if (
    !['docs.createDraft@1.0.0', 'calendar.createEvent@1.0.0', 'gmail.createDraft@1.0.0'].includes(
      approval.tool,
    )
  )
    throw new ConnectorError('RESOURCE_DENIED', 403);
  return approval;
}
