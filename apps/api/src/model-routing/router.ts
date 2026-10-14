import { randomUUID } from 'node:crypto';

import { sameBoundary } from '../../../../packages/domain/dist/model-policy.js';

import { ModelRoutingDenied, RetryableModelFailure } from './errors.js';
import { approvedModel, parseModelPolicy } from './policy.js';

import type { BenchmarkPort } from './benchmark.js';
import type { ModelPolicy } from './policy.js';
import type {
  ApprovedModel,
  ModelIdentity,
  ModelRoutingAudit,
  RoutingRule,
} from '../../../../packages/domain/dist/model-policy.js';
import type { ModelRoutingPort } from '../ports/model-routing.js';
export type InferenceContext = {
  readonly taskId: string;
  readonly traceId: string;
  readonly taskClass: string;
  readonly region: string;
  readonly governanceZone: string;
  readonly estimatedCostMicros: number;
};
export type ModelRouter = {
  run<T>(
    context: InferenceContext,
    operation: (model: ApprovedModel, inferenceId: string) => Promise<T>,
  ): Promise<T>;
};
export function createModelRouter(options: {
  policy: ModelPolicy;
  benchmarks: BenchmarkPort;
  records: ModelRoutingPort;
  now?: () => Date;
  id?: () => string;
}): ModelRouter {
  const policy = parseModelPolicy(options.policy);
  const now = options.now ?? (() => new Date());
  const id = options.id ?? randomUUID;
  async function evidence(
    context: InferenceContext,
    requested: ModelIdentity,
    reason: ModelRoutingAudit['reason'],
    rule?: RoutingRule,
  ): Promise<void> {
    await options.records.audit({
      eventId: id(),
      taskId: context.taskId,
      traceId: context.traceId,
      occurredAt: now().toISOString(),
      reason,
      requested: {
        modelId: requested.modelId,
        version: requested.version,
        region: requested.region,
        governanceZone: requested.governanceZone,
      },
      ruleId: rule?.ruleId ?? null,
    });
  }
  async function authorize(
    context: InferenceContext,
    requested: ModelIdentity,
    rule?: RoutingRule,
  ): Promise<ApprovedModel> {
    const reason =
      requested.governanceZone !== context.governanceZone
        ? 'cross_zone'
        : requested.region !== context.region
          ? 'cross_region'
          : approvedModel(policy, requested) === undefined
            ? 'not_allowlisted'
            : undefined;
    if (reason !== undefined) {
      await evidence(context, requested, reason, rule);
      throw new ModelRoutingDenied(reason);
    }
    return approvedModel(policy, requested)!;
  }
  async function chain(
    context: InferenceContext,
  ): Promise<{ models: readonly ApprovedModel[]; rule?: RoutingRule }> {
    const rule = policy.rules.find((row) => row.taskClass === context.taskClass);
    if (rule === undefined) return { models: [await authorize(context, policy.defaultModel)] };
    if (!(await options.benchmarks.enabled(rule))) {
      await evidence(context, rule.target, 'benchmark_disabled', rule);
      return { models: [await authorize(context, policy.defaultModel)] };
    }
    const models: ApprovedModel[] = [];
    for (const identity of [rule.target, ...rule.fallbacks]) {
      if (!sameBoundary(rule.target, identity)) {
        const reason = rule.target.region !== identity.region ? 'cross_region' : 'cross_zone';
        await evidence(context, identity, reason, rule);
        throw new ModelRoutingDenied(reason);
      }
      models.push(await authorize(context, identity, rule));
    }
    return { models, rule };
  }
  return {
    async run(context, operation) {
      const selected = await chain(context);
      for (const [attempt, model] of selected.models.entries()) {
        const inferenceId = id();
        await options.records.start({
          inferenceId,
          taskId: context.taskId,
          traceId: context.traceId,
          model: {
            modelId: model.modelId,
            version: model.version,
            region: model.region,
            governanceZone: model.governanceZone,
          },
          costClass: model.costClass,
          ruleId: selected.rule?.ruleId ?? null,
          attempt,
          status: 'started',
          occurredAt: now().toISOString(),
          estimatedCostMicros: context.estimatedCostMicros,
        });
        let result;
        try {
          result = await operation(model, inferenceId);
        } catch (error) {
          await options.records.finish(inferenceId, 'failed');
          if (!(error instanceof RetryableModelFailure)) throw error;
          continue;
        }
        await options.records.finish(inferenceId, 'succeeded');
        return result;
      }
      await evidence(context, selected.models[0], 'fallback_exhausted', selected.rule);
      throw new ModelRoutingDenied('fallback_exhausted');
    },
  };
}
