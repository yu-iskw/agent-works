import * as z from 'zod';

const label = z.string().min(1);

export const POLICY_CLAUSES = [
  'authenticated_actor',
  'active_org_membership',
  'permitted_app_role',
  'approved_agent_and_skill_version',
  'agent_has_tool_capability',
  'user_or_service_has_resource_authority',
  'source_system_allows_operation',
  'data_classification_policy_allows',
  'valid_approval_if_required',
  'within_time_and_budget_bounds',
] as const;

export type PolicyClause = (typeof POLICY_CLAUSES)[number];

const decisionId = z.uuid();

export const policyDecisionSchema = z.discriminatedUnion('effect', [
  z.strictObject({
    effect: z.literal('allow'),
    decisionId,
    policyVersion: label,
  }),
  z.strictObject({
    effect: z.literal('deny'),
    decisionId,
    policyVersion: label,
    failedClauses: z.array(z.enum(POLICY_CLAUSES)).min(1),
  }),
]);

export type PolicyDecision = z.infer<typeof policyDecisionSchema>;
