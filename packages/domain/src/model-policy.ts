import * as z from 'zod';
const label = z.string().min(1).max(200);
export const modelIdentitySchema = z.strictObject({
  modelId: label,
  version: label,
  region: label,
  governanceZone: label,
});
export const approvedModelSchema = modelIdentitySchema.extend({
  costClass: z.enum(['economy', 'standard', 'premium']),
  approvalRef: label,
});
export type ModelIdentity = z.infer<typeof modelIdentitySchema>;
export type ApprovedModel = z.infer<typeof approvedModelSchema>;
export const routingRuleSchema = z.strictObject({
  ruleId: label,
  taskClass: label,
  target: modelIdentitySchema,
  fallbacks: z.array(modelIdentitySchema).max(8),
  benchmarkArtifact: label.optional(),
});
export type RoutingRule = z.infer<typeof routingRuleSchema>;
export const inferenceRecordSchema = z.strictObject({
  inferenceId: label,
  taskId: label,
  traceId: label,
  model: modelIdentitySchema,
  costClass: z.enum(['economy', 'standard', 'premium']),
  ruleId: label.nullable(),
  attempt: z.number().int().nonnegative(),
  status: z.enum(['started', 'succeeded', 'failed']),
  occurredAt: z.iso.datetime(),
  estimatedCostMicros: z.number().int().nonnegative().safe(),
});
export type InferenceRecord = z.infer<typeof inferenceRecordSchema>;
export const modelRoutingAuditSchema = z.strictObject({
  eventId: label,
  taskId: label,
  traceId: label,
  occurredAt: z.iso.datetime(),
  reason: z.enum([
    'not_allowlisted',
    'cross_zone',
    'cross_region',
    'benchmark_disabled',
    'fallback_exhausted',
  ]),
  requested: modelIdentitySchema,
  ruleId: label.nullable(),
});
export type ModelRoutingAudit = z.infer<typeof modelRoutingAuditSchema>;
export function modelKey(model: ModelIdentity): string {
  return JSON.stringify([model.modelId, model.version, model.region, model.governanceZone]);
}
export function sameBoundary(left: ModelIdentity, right: ModelIdentity): boolean {
  return left.region === right.region && left.governanceZone === right.governanceZone;
}
