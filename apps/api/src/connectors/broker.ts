import { canonicalPayloadSha256 } from '@agent-works/domain';
import { ZodError } from 'zod';

import {
  parseWorkspacePayload,
  workspaceTarget,
  workspaceToolRef,
} from '../../../../packages/domain/dist/workspace-tools.js';
import { registeredToolManifests } from '../broker/broker.js';

import { ConnectorError } from './errors.js';
import { classifySources } from './source-data.js';

import type { WorkspaceCredentials } from './credentials.js';
import type { CallerCredential } from './google-http.js';
import type { WorkspaceAdapters } from './ports.js';
import type { ClassifiedSource } from './source-data.js';
import type {
  WorkspaceToolName,
  WorkspaceReceipt,
} from '../../../../packages/domain/dist/workspace-tools.js';
import type { ApprovalStore } from '../broker/approvals.js';
import type { GovernanceClassification } from '@agent-works/domain/data-governance';
export type WorkspaceCall = {
  readonly subject: string;
  readonly taskId: string;
  readonly stepId: string;
  readonly tool: WorkspaceToolName;
  readonly payload: unknown;
  readonly callId: string;
  readonly idempotencyKey: string;
  readonly approvalId?: string;
  readonly traceId: string;
  readonly signal?: AbortSignal;
};
export type WorkspaceAudit = {
  readonly type: 'tool.intended' | 'tool.completed' | 'tool.denied';
  readonly subject: string;
  readonly tool: string;
  readonly callId: string;
  readonly payloadSha256?: string;
  readonly code?: string;
  readonly receipt?: string;
};
export type WorkspaceBrokerDeps = {
  readonly credentials: WorkspaceCredentials;
  readonly approvals: ApprovalStore;
  readonly adapters: WorkspaceAdapters;
  readonly now: () => Date;
  readonly authorize: (input: WorkspaceCall) => Promise<{
    readonly allowed: boolean;
    readonly ceiling: GovernanceClassification;
    readonly decisionId: string;
  }>;
  readonly approverAuthorized: (subject: string) => boolean;
  readonly audit: (event: WorkspaceAudit) => Promise<void>;
};
export type WorkspaceResult = WorkspaceReceipt | readonly ClassifiedSource[];
export function createWorkspaceBroker(deps: WorkspaceBrokerDeps) {
  const active = new Set<string>();
  return {
    async execute(input: WorkspaceCall): Promise<WorkspaceResult> {
      if (active.has(input.callId) || active.has(input.idempotencyKey))
        throw new ConnectorError('DUPLICATE_CALL', 409);
      active.add(input.callId);
      active.add(input.idempotencyKey);
      try {
        return await execute(deps, input);
      } catch (error) {
        const failure =
          error instanceof ZodError ? new ConnectorError('INVALID_REQUEST', 400) : error;
        await deps.audit({
          type: 'tool.denied',
          subject: input.subject,
          tool: input.tool,
          callId: input.callId,
          code: failure instanceof ConnectorError ? failure.code : 'UPSTREAM_UNAVAILABLE',
        });
        throw failure;
      } finally {
        active.delete(input.callId);
        active.delete(input.idempotencyKey);
      }
    },
  };
}
async function execute(deps: WorkspaceBrokerDeps, input: WorkspaceCall): Promise<WorkspaceResult> {
  const manifest = registeredToolManifests.find((entry) => entry.metadata.name === input.tool);
  if (!manifest || input.tool === 'gmail.send') throw new ConnectorError('POLICY_DENIED', 403);
  const payload = parseWorkspacePayload(input.tool, input.payload);
  const authorized = await deps.authorize({ ...input, payload });
  if (!authorized.allowed) throw new ConnectorError('POLICY_DENIED', 403);
  const credential = await deps.credentials.forTool(input.subject, input.tool);
  input.signal?.throwIfAborted();
  if (manifest.spec.sideEffect === 'READ') {
    const rows =
      input.tool === 'calendar.listEvents'
        ? await deps.adapters.calendar.listEvents(credential, payload, input.signal)
        : await deps.adapters.gmail.searchThreads(credential, payload, input.signal);
    return classifySources(rows, authorized.ceiling, input.tool === 'gmail.searchThreads');
  }
  return write(deps, { ...input, payload }, credential, authorized.decisionId);
}
async function write(
  deps: WorkspaceBrokerDeps,
  input: WorkspaceCall,
  credential: CallerCredential,
  decisionId: string,
): Promise<WorkspaceReceipt> {
  if (!input.approvalId) throw new ConnectorError('APPROVAL_REQUIRED');
  const digest = canonicalPayloadSha256(input.payload);
  const approval = await deps.approvals.read(input.approvalId);
  if (!approval || approval.requestedBySub !== input.subject || approval.maxExecutions !== 1)
    throw new ConnectorError('APPROVAL_REQUIRED');
  const claim = await deps.approvals.claim({
    approvalId: input.approvalId,
    callId: input.callId,
    taskId: input.taskId,
    stepId: input.stepId,
    toolRef: workspaceToolRef(input.tool),
    idempotencyKey: input.idempotencyKey,
    targetResource: workspaceTarget(input.tool, input.payload),
    payloadSha256: digest,
    policyDecisionId: decisionId,
    intendedAt: deps.now(),
    traceId: input.traceId,
    actorSub: input.subject,
    approverAuthorized: deps.approverAuthorized,
    now: deps.now(),
  });
  if (claim.kind === 'replay' || claim.kind === 'duplicate')
    throw new ConnectorError('DUPLICATE_CALL', 409);
  if (claim.kind === 'missing') throw new ConnectorError('APPROVAL_REQUIRED');
  if (claim.kind === 'deny') throw new ConnectorError(claim.code);
  await deps.audit({
    type: 'tool.intended',
    subject: input.subject,
    tool: input.tool,
    callId: input.callId,
    payloadSha256: digest,
  });
  input.signal?.throwIfAborted();
  const receipt = await invokeWrite(deps.adapters, input, credential);
  await deps.approvals.complete(input.callId, receipt.id);
  await deps.audit({
    type: 'tool.completed',
    subject: input.subject,
    tool: input.tool,
    callId: input.callId,
    payloadSha256: digest,
    receipt: receipt.id,
  });
  return receipt;
}
function invokeWrite(
  adapters: WorkspaceAdapters,
  input: WorkspaceCall,
  credential: CallerCredential,
): Promise<WorkspaceReceipt> {
  switch (input.tool) {
    case 'docs.createDraft':
      return adapters.docs.createDraft(
        credential,
        input.payload,
        input.idempotencyKey,
        input.signal,
      );
    case 'calendar.createEvent':
      return adapters.calendar.createEvent(
        credential,
        input.payload,
        input.idempotencyKey,
        input.signal,
      );
    case 'gmail.createDraft':
      return adapters.gmail.createDraft(
        credential,
        input.payload,
        input.idempotencyKey,
        input.signal,
      );
    case 'calendar.listEvents':
    case 'gmail.searchThreads':
    case 'gmail.send':
      throw new ConnectorError('POLICY_DENIED', 403);
  }
}
export type WorkspaceBroker = ReturnType<typeof createWorkspaceBroker>;
