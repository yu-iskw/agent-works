import { randomUUID } from 'node:crypto';

import { rolesAt } from '../auth/directory.js';
import { applyBudgetMigration } from '../finops/migration.js';
import { createPostgresBudgetPort } from '../finops/postgres-budget.js';
import { createPostgresSchedulePort } from '../ports/schedule-postgres.js';
import { createLocalEngine } from '../workflow/local-engine.js';
import {
  createPostgresWorkflowLog,
  createPostgresWorkflowPort,
} from '../workflow/postgres-workflow.js';

import { createScheduleCancel } from './cancel.js';
import { readScheduleConfiguration } from './configuration.js';
import { createLocalConsentRegistry } from './consent.js';
import { createEventIngestor } from './ingestion.js';
import { createLocalKeyRegistry, publicSigningKey } from './keys.js';
import { createScheduler } from './service.js';
import { createScheduleWorker } from './worker.js';

import type { AuthorityResolver } from './authority.js';
import type { ScheduleConfiguration } from './configuration.js';
import type { VerifyAssertion } from '../auth/iap.js';
import type { BudgetPort } from '../finops/budget-port.js';
import type { DispatchPort } from '../ports/dispatch-port.js';
import type { LedgerPort } from '../ports/ledger-port.js';
import type { SkillRegistry } from '../skills/registry.js';
import type { SuspensionEnforcer } from '../suspension/enforcement.js';
import type { LocalEngine } from '../workflow/local-engine.js';
import type postgres from 'postgres';
export type ScheduleRuntimeOptions = {
  sql: postgres.Sql;
  verify: VerifyAssertion;
  dispatch: DispatchPort;
  ledger: LedgerPort;
  skills: SkillRegistry;
  suspension: SuspensionEnforcer;
  groups: (sub: string) => Promise<{ sub: string; groups: string[]; observedAt: string }>;
  now: () => Date;
  configurationPath?: string;
};
export function createScheduleRuntime(options: ScheduleRuntimeOptions) {
  const config = readScheduleConfiguration(options.configurationPath);
  const store = createPostgresSchedulePort(options.sql);
  const authority = runtimeAuthority(options, config);
  const keys = createLocalKeyRegistry(
    config.keys.map((key) =>
      key.algorithm === 'HS256'
        ? {
            id: key.id,
            source: key.source,
            algorithm: key.algorithm,
            secret: Buffer.from(key.material, 'base64'),
            revoked: key.revoked,
          }
        : {
            ...publicSigningKey(key.id, key.source, key.algorithm, key.material),
            revoked: key.revoked,
          },
    ),
  );
  const limit = {
    approval: 'PLACEHOLDER' as const,
    estimatedCostMicros: 1000000000000,
    inferenceSteps: 1000000,
    parallelism: 1000000,
  };
  const scheduler = createScheduler({
    store,
    authority,
    consent: createLocalConsentRegistry(config.consents),
    suspension: options.suspension,
    budget: schedulingBudget(options.sql),
    budgetPolicy: { task: limit, user: limit, mode: 'observe' },
    model: 'gemini',
    now: options.now,
    owner: randomUUID(),
    dispatch: options.dispatch,
    cancel: createScheduleCancel(options.ledger),
    findTask: async (subject, idempotencyKey) => {
      const rows = await options.sql<
        { task_id: string }[]
      >`select task_id from task_claims where subject=${subject} and idempotency_key=${idempotencyKey}`;
      return rows.at(0)?.task_id;
    },
    taskStatus: async (subject, id) => (await options.ledger.read(subject, id))?.status,
    engine: lazyEngine(options),
  });
  const worker = createScheduleWorker(scheduler, () =>
    console.error('schedule worker operation failed'),
  );
  return Promise.resolve({
    routes: { verify: options.verify, store, scheduler, authority },
    events: createEventIngestor({ store, scheduler, keys, now: options.now }),
    worker,
  });
}
function runtimeAuthority(
  options: ScheduleRuntimeOptions,
  config: ScheduleConfiguration,
): AuthorityResolver {
  return async (spec) => {
    const snapshot = await options.groups(spec.sponsor.sub);
    const roles = rolesAt(snapshot, options.now().getTime());
    const configured = config.authorities.find(
      (v) =>
        v.subject === spec.sponsor.sub &&
        v.privilege.skill.id === spec.maxPrivilege.skill.id &&
        v.privilege.skill.version === spec.maxPrivilege.skill.version,
    );
    const skill = options.skills.get(spec.task.skillId);
    const privilege = configured?.privilege ?? {
      ...spec.maxPrivilege,
      scopes: [],
      sources: [],
      regions: [],
      budgetUsd: 0,
      deadlineSeconds: 1,
    };
    const active =
      roles.includes('Employee') &&
      configured !== undefined &&
      skill !== undefined &&
      skill.manifest.version === spec.maxPrivilege.skill.version &&
      skill.validate(spec.task) &&
      skill.manifest.tools.every((v) => spec.maxPrivilege.scopes.includes(v));
    return {
      active,
      subject: snapshot.sub,
      teams: snapshot.groups,
      privilege,
      context: {
        userSubject: snapshot.sub,
        enterpriseId: spec.sponsor.enterpriseId,
        authorizedGroups: snapshot.groups,
        groupsObservedAt: snapshot.observedAt,
        allowedSources: privilege.sources,
        taskPurpose: spec.purpose,
        classificationCeiling: privilege.classification,
        allowedRegions: privilege.regions,
        resultCountLimit: 10,
      },
    };
  };
}

function lazyEngine(options: ScheduleRuntimeOptions): Pick<LocalEngine, 'run'> {
  let engine: LocalEngine | undefined;
  return {
    run(plan) {
      engine ??= createLocalEngine({
        workflow: createPostgresWorkflowPort(options.sql),
        log: createPostgresWorkflowLog(options.sql),
        ledger: options.ledger,
        now: options.now,
      });
      return engine.run(plan);
    },
  };
}
function schedulingBudget(sql: postgres.Sql): BudgetPort {
  const budget = createPostgresBudgetPort(sql);
  let ready: Promise<void> | undefined;
  const ensure = () => (ready ??= applyBudgetMigration(sql));
  return {
    async reserve(charge, policy) {
      await ensure();
      return budget.reserve(charge, policy);
    },
    async release(id) {
      await ensure();
      return budget.release(id);
    },
    async events() {
      await ensure();
      return budget.events();
    },
  };
}
