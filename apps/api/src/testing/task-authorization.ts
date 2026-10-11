import type { TaskAuthorization } from '../routes/tasks.js';
import type { AuthorizedCaller } from '../skills/incident.js';

export const taskAuthorization = {
  now: () => new Date(),
  wire: {
    groups: () =>
      Promise.resolve({
        groups: ['agent-users@company.example'],
        observedAt: new Date().toISOString(),
      }),
    policyInput: () =>
      Promise.resolve({
        facts: {
          approved_agent_and_skill_version: true,
          agent_has_tool_capability: true,
          user_or_service_has_resource_authority: true,
          source_system_allows_operation: true,
          data_classification_policy_allows: true,
          valid_approval_if_required: true,
          within_time_and_budget_bounds: true,
        },
      }),
  },
} satisfies TaskAuthorization;

export const authorizedCaller: AuthorizedCaller = {
  caller: { sub: 'alice' } as AuthorizedCaller['caller'],
  context: {
    userSubject: 'alice',
    enterpriseId: 'agent-works',
    authorizedGroups: ['agent-users@company.example'],
    groupsObservedAt: new Date().toISOString(),
    allowedSources: ['incidents'],
    taskPurpose: 'incident-analysis',
    classificationCeiling: 'INTERNAL',
    allowedRegions: ['us'],
    resultCountLimit: 3,
  },
  decision: { effect: 'allow', decisionId: 'decision-1', policyVersion: '1' },
};
