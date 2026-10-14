import * as z from 'zod';

import { workspaceToolNames } from '../../../../packages/domain/dist/workspace-tools.js';
const label = z.string().min(1).max(512);
export const workspaceExecuteSchema = z.strictObject({
  tool: z.enum(workspaceToolNames),
  payload: z.unknown(),
  taskId: label,
  stepId: label,
  callId: label,
  idempotencyKey: label,
  traceId: label,
  approvalId: label.optional(),
});
export const workspaceDecisionSchema = z.strictObject({
  approvalId: label,
  decision: z.enum(['approve', 'reject']),
  expectedPayloadSha256: z.string().regex(/^[a-f0-9]{64}$/),
});
export const workspaceApprovalReadSchema = z.strictObject({ approvalId: label });
export const workspaceScopeRequestSchema = z.strictObject({
  tool: z.enum(workspaceToolNames),
  state: label,
  codeChallenge: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
  codeChallengeMethod: z.literal('S256'),
});
