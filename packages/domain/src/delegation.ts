import * as z from 'zod';

import { budgetLimitsSchema } from './budget.js';
const label = z.string().min(1).max(200);
/** Exact capability/resource pairs avoid unsafe independent scope/resource cartesian products. */
const delegatedGrantSchema = z.strictObject({ capability: label, resource: label });
export const delegationAuthoritySchema = z.strictObject({
  subject: label,
  agentPrincipal: label,
  governanceZone: label,
  region: label,
  grants: z.array(delegatedGrantSchema).max(256),
  expiresAt: z.iso.datetime(),
  policyDecisionRef: label,
});
export type DelegationAuthority = z.infer<typeof delegationAuthoritySchema>;
export const delegationContextSchema = z.strictObject({
  taskId: label,
  rootTaskId: label,
  parentTaskId: label.nullable(),
  traceId: label,
  depth: z.number().int().nonnegative(),
  authority: delegationAuthoritySchema,
  budgetShare: budgetLimitsSchema,
  budgetScope: z.strictObject({ taskId: label, userSubject: label, sponsor: label, window: label }),
});
export type DelegationContext = z.infer<typeof delegationContextSchema>;
export const delegationEdgeSchema = z.strictObject({
  childTaskId: label,
  parentTaskId: label,
  rootTaskId: label,
  traceId: label,
  depth: z.number().int().positive(),
  delegatedAuthorityHash: z.string().regex(/^[a-f0-9]{64}$/),
  budgetShare: budgetLimitsSchema,
  state: z.enum(['pending', 'verified', 'rejected', 'failed']),
  resultDigest: z
    .string()
    .regex(/^[a-f0-9]{64}$/)
    .nullable(),
  verifierRef: label.nullable(),
  occurredAt: z.iso.datetime(),
});
export type DelegationEdge = z.infer<typeof delegationEdgeSchema>;
export const delegationAuditSchema = z.strictObject({
  eventId: label,
  parentTaskId: label,
  childTaskId: label,
  traceId: label,
  occurredAt: z.iso.datetime(),
  reason: z.enum([
    'disabled',
    'depth',
    'expired',
    'boundary',
    'budget_share',
    'identity',
    'verification_failed',
    'execution_failed',
  ]),
});
export type DelegationAudit = z.infer<typeof delegationAuditSchema>;
