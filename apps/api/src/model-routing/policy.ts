import { approvedModelSchema, modelKey, routingRuleSchema } from '@agent-works/domain/model-policy';

import type { ApprovedModel, ModelIdentity, RoutingRule } from '@agent-works/domain/model-policy';
export type ModelPolicy = {
  readonly defaultModel: ModelIdentity;
  readonly allowlist: readonly ApprovedModel[];
  readonly rules: readonly RoutingRule[];
};
export function parseModelPolicy(input: ModelPolicy): ModelPolicy {
  const allowlist = input.allowlist.map((row) => approvedModelSchema.parse(row));
  const rules = input.rules.map((row) => routingRuleSchema.parse(row));
  if (new Set(allowlist.map(modelKey)).size !== allowlist.length)
    throw new Error('duplicate model identity');
  if (new Set(rules.map((row) => row.taskClass)).size !== rules.length)
    throw new Error('duplicate task class');
  return structuredClone({ defaultModel: input.defaultModel, allowlist, rules });
}
export function approvedModel(
  policy: ModelPolicy,
  identity: ModelIdentity,
): ApprovedModel | undefined {
  return policy.allowlist.find((model) => modelKey(model) === modelKey(identity));
}
