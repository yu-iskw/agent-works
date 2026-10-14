import { randomUUID } from 'node:crypto';

import { scheduleFixture, eventTriggerFixture, scheduleHash } from '@agent-works/domain';

import { createMemoryBudgetPort } from '../finops/memory-budget.js';
import { createMemorySchedulePort } from '../ports/memory/schedule-port.js';
import { createMemorySuspensionLedger } from '../ports/memory/suspension-ledger.js';
import { createMemoryTaskPorts } from '../ports/memory/task-ports.js';
import { createMemoryWorkflowPort } from '../ports/memory/workflow.js';
import { createIncidentSkill } from '../skills/incident.js';
import { publishBundledCapabilities } from '../suspension/bootstrap.js';
import { createSuspensionEnforcer } from '../suspension/enforcement.js';
import { bundledVersionBaseline } from '../suspension/runtime.js';
import { createLocalEngine } from '../workflow/local-engine.js';
import { createMemoryWorkflowLog } from '../workflow/workflow-log.js';

import { createScheduleCancel } from './cancel.js';
import { createFakeScheduleClock } from './clock.js';
import { createLocalConsentRegistry } from './consent.js';
import { createScheduler } from './service.js';

import type { SponsorAuthority } from './authority.js';
import type { SchedulerDeps } from './service.js';
import type { ScheduleSpec } from '@agent-works/domain';
export { scheduleFixture, eventTriggerFixture };
export async function schedulerFixture(overrides: Partial<ScheduleSpec> = {}) {
  const spec = scheduleFixture(overrides);
  const clock = createFakeScheduleClock();
  const store = createMemorySchedulePort();
  const budget = createMemoryBudgetPort();
  const suspensionLedger = createMemorySuspensionLedger();
  const tasks = createMemoryTaskPorts(clock.now);
  await publishBundledCapabilities(
    suspensionLedger,
    bundledVersionBaseline(createIncidentSkill().manifest),
  );
  const consent = createLocalConsentRegistry([
    {
      ref: spec.consentRef,
      subject: spec.sponsor.sub,
      digest: scheduleHash(spec),
      expiresAt: spec.expiresAt,
    },
  ]);
  const current: SponsorAuthority = {
    active: true,
    subject: spec.sponsor.sub,
    teams: ['team-a'],
    privilege: structuredClone(spec.maxPrivilege),
    context: {
      userSubject: spec.sponsor.sub,
      enterpriseId: 'company',
      authorizedGroups: ['team-a'],
      groupsObservedAt: clock.now().toISOString(),
      allowedSources: ['incidents'],
      taskPurpose: spec.purpose,
      classificationCeiling: 'INTERNAL',
      allowedRegions: ['asia-northeast1'],
      resultCountLimit: 10,
    },
  };
  const limit = {
    approval: 'PLACEHOLDER' as const,
    estimatedCostMicros: 10000000,
    inferenceSteps: 100,
    parallelism: 10,
  };
  const acceptedTasks = new Map<string, string>();
  const deps: SchedulerDeps = {
    store,
    now: clock.now,
    owner: 'worker-a',
    authority: () => Promise.resolve(structuredClone(current)),
    consent,
    budget,
    budgetPolicy: { task: limit, user: limit, mode: 'isolated-test-enforce' },
    suspension: createSuspensionEnforcer({ ledger: suspensionLedger, now: clock.now }),
    model: 'gemini',
    dispatch: {
      async accept(input) {
        const result = await tasks.dispatch.accept(input);
        acceptedTasks.set(JSON.stringify([input.subject, input.idempotencyKey]), result.taskId);
        return result;
      },
    },
    findTask: (subject, key) => Promise.resolve(acceptedTasks.get(JSON.stringify([subject, key]))),
    cancel: createScheduleCancel(tasks.ledger),
    taskStatus: async (subject, id) => (await tasks.ledger.read(subject, id))?.status,
    engine: createLocalEngine({
      workflow: createMemoryWorkflowPort(),
      log: createMemoryWorkflowLog(),
      ledger: tasks.ledger,
      now: clock.now,
    }),
  };
  return {
    spec,
    clock,
    store,
    budget,
    suspensionLedger,
    tasks,
    consent,
    current,
    deps,
    acceptedTasks,
    scheduler: createScheduler(deps),
  };
}
export async function suspendFixture(
  f: Awaited<ReturnType<typeof schedulerFixture>>,
  scope: 'global' | 'team' | 'skill' | 'user' | 'agent' | 'model',
) {
  const ids = new Map([
    ['global', '*'],
    ['team', 'team-a'],
    ['user', 'alice'],
    ['model', 'gemini'],
    ['agent', 'api'],
    ['skill', f.spec.maxPrivilege.skill.id],
  ]);
  const id = ids.get(scope)!;
  await f.suspensionLedger.change(
    {
      kind: 'suspension',
      command: {
        commandId: randomUUID(),
        action: 'suspend',
        target:
          scope === 'global'
            ? { scope: 'global', id: '*', version: null }
            : { scope, id, version: null },
        reason: 'Test suspension',
        expiresAt: null,
        expectedRevision: 0,
      },
    },
    'operator',
    f.clock.now(),
  );
}
