import { parseWorkspacePayload, workspaceManifests } from '@agent-works/domain/workspace-tools';

import { prepareWorkspaceApproval } from '../connectors/approval.js';
import { ConnectorError } from '../connectors/errors.js';

import type { RegisteredSkill } from './incident.js';
import type { MeetingPrepDeps, MeetingPrepResult } from './meeting-prep.js';
import type { WorkspaceCall } from '../connectors/broker.js';
import type { TaskSubmit } from '@agent-works/domain';
import type { WorkspaceToolName } from '@agent-works/domain/workspace-tools';

const tools = workspaceManifests
  .map((manifest) => manifest.metadata.name)
  .filter((tool) => tool !== 'gmail.send');
/** A caller-selected workspace operation still requires task policy, declared tools,
 * caller OAuth scopes and a payload-bound human approval for writes. */
export function createWorkspaceTaskSkill(
  config: () => Pick<MeetingPrepDeps, 'broker' | 'approvals' | 'now'> | undefined = () => undefined,
) {
  const results = new Map<string, MeetingPrepResult>();
  const skill: RegisteredSkill = {
    manifest: { id: 'workspace-task', version: '1.0.0', state: 'PUBLISHED', tools },
    validate,
    async dispatch(request, accepted, authorized, execution) {
      const deps = config();
      if (!deps || !validate(request)) throw new ConnectorError('POLICY_DENIED', 403);
      const tool = request.input?.tool as WorkspaceToolName;
      if (!authorized.context.allowedSources.includes(tool.split('.')[0]))
        throw new ConnectorError('POLICY_DENIED', 403);
      const call: WorkspaceCall = {
        subject: authorized.caller.sub,
        taskId: accepted.taskId,
        stepId: 'workspace',
        tool,
        callId: `workspace:${accepted.taskId}`,
        idempotencyKey: `workspace:${accepted.taskId}`,
        traceId: accepted.traceId,
        payload: request.input?.payload,
        signal: execution?.signal,
      };
      const approvalId = request.input?.approvalId;
      if (typeof approvalId === 'string') {
        const approval = await deps.approvals.read(approvalId);
        if (
          !approval ||
          approval.taskId !== call.taskId ||
          approval.requestedBySub !== call.subject
        )
          throw new ConnectorError('APPROVAL_REQUIRED');
        const result = await deps.broker.execute({
          ...call,
          approvalId,
          payload: await deps.approvals.readPayload(approvalId),
        });
        if (Array.isArray(result) || !('id' in result))
          throw new ConnectorError('INVALID_RESPONSE', 502);
        results.set(call.taskId, { kind: 'written', documentId: result.id });
      } else if (['calendar.createEvent', 'gmail.createDraft', 'docs.createDraft'].includes(tool)) {
        const prepared = await prepareWorkspaceApproval(deps.approvals, call, deps.now());
        results.set(call.taskId, {
          kind: 'approval-required',
          approvalId: prepared.approval.id,
          payloadSha256: prepared.approval.payloadSha256,
        });
      } else {
        await deps.broker.execute(call);
      }
    },
  };
  return { ...skill, result: (taskId: string) => results.get(taskId) };
}
function validate(request: TaskSubmit): boolean {
  const tool = request.input?.tool;
  if (typeof tool !== 'string' || !tools.includes(tool)) return false;
  try {
    parseWorkspacePayload(tool as WorkspaceToolName, request.input?.payload);
    return true;
  } catch {
    return false;
  }
}
