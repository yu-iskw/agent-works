import { decide } from '@agent-works/policy';

import { checkAuthority, pinnedContext, ScheduleDenied } from './authority.js';

import type { AuthorityResolver, ConsentRegistry } from './authority.js';
import type { BudgetPolicy, BudgetPort } from '../finops/budget-port.js';
import type { AcceptTask } from '../ports/dispatch-port.js';
import type { SuspensionEnforcer } from '../suspension/enforcement.js';
import type { ScheduleRecord, ScheduleRun } from '@agent-works/domain';
export const runtimeAgentPin = { kind: 'agent', id: 'api', version: '1' } as const;

export type AdmissionDeps = {
  authority: AuthorityResolver;
  consent: ConsentRegistry;
  suspension: SuspensionEnforcer;
  budget: BudgetPort;
  budgetPolicy: BudgetPolicy;
  model: string;
};
export async function admit(
  row: ScheduleRecord,
  run: ScheduleRun,
  now: Date,
  deps: AdmissionDeps,
): Promise<AcceptTask> {
  const spec = row.spec;
  const current = await checkAuthority(spec, row.digest, now, deps);
  await deps.suspension.check(
    {
      subject: spec.sponsor.sub,
      teams: current.teams,
      agent: runtimeAgentPin,
      skill: { kind: 'skill', ...spec.maxPrivilege.skill },
      model: deps.model,
      taskId: run.id,
      traceId: run.id.slice(0, 32),
    },
    'admission',
  );
  const reservation = await deps.budget.reserve(
    {
      operationId: run.id,
      scope: {
        taskId: run.id,
        userSubject: spec.sponsor.sub,
        sponsor: spec.sponsor.sub,
        window: run.fireAt.slice(0, 10),
      },
      estimatedCostMicros: Math.ceil(spec.task.executionPolicy.budgetUsd * 1000000),
      inferenceSteps: 1,
      parallelism: 1,
    },
    deps.budgetPolicy,
  );
  if (!reservation.allowed) throw new ScheduleDenied('BUDGET_EXHAUSTED');
  const policy = decide({
    facts: {
      authenticated_actor: true,
      active_org_membership: true,
      permitted_app_role: true,
      approved_agent_and_skill_version: true,
      agent_has_tool_capability: true,
      user_or_service_has_resource_authority: true,
      source_system_allows_operation: true,
      data_classification_policy_allows: true,
      valid_approval_if_required: true,
      within_time_and_budget_bounds: true,
    },
  });
  if (policy.effect !== 'allow') throw new ScheduleDenied('POLICY_DENIED');
  return {
    subject: spec.sponsor.sub,
    idempotencyKey: `schedule:${run.id}`,
    request: structuredClone(spec.task),
    policy,
    agent: {
      kind: 'agent',
      agentId: runtimeAgentPin.id,
      version: runtimeAgentPin.version,
      identityRef: `agent://${runtimeAgentPin.id}`,
    },
    context: pinnedContext(spec, current),
    deadline: new Date(
      Math.min(
        Date.parse(spec.expiresAt),
        now.getTime() + spec.task.executionPolicy.deadlineSeconds * 1000,
      ),
    ).toISOString(),
  };
}
