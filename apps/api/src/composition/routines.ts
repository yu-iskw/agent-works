import { readGrantActivation } from '../authority-lifecycle/lifecycle.js';
import { applyStandingGrantMigration } from '../authority-lifecycle/migration.js';
import { createPostgresGrantStore } from '../authority-lifecycle/postgres-store.js';
import { applyRoutineMigration } from '../scheduling/routines/migration.js';
import { createPostgresRoutineStore } from '../scheduling/routines/postgres-store.js';
import { createRoutineSchedules } from '../scheduling/routines/scheduler-adapter.js';
import { createRoutineService } from '../scheduling/routines/service.js';

import type { AuthorityResolver } from '../scheduling/authority.js';
import type postgres from 'postgres';

type RoutineService = ReturnType<typeof createRoutineService>;
type SchedulerParts = Parameters<typeof createRoutineSchedules>[0];

export type RoutineWiring = {
  /** Passed to the schedule runtime so every tick, claim and recheck also asks the grant. */
  readonly guard: (base: AuthorityResolver) => AuthorityResolver;
  /** Called once the runtime exists; returns the service whose `sweep` the tick loop runs. */
  readonly bind: (scheduler: SchedulerParts) => RoutineService;
};

/**
 * Standing-grant routines, behind the O04 gate (`AW_STANDING_GRANTS=on` plus an approval
 * reference). Returns undefined when the gate is closed, and then nothing reads the grant tables.
 * Until `bind` runs the guard denies every spec, so a scheduler that outran wiring cannot act.
 */
export async function prepareRoutines(
  sql: postgres.Sql,
  env: Readonly<Record<string, string | undefined>>,
  now: () => Date,
): Promise<RoutineWiring | undefined> {
  const activation = readGrantActivation(env);
  if (!activation.enabled) return undefined;
  await applyStandingGrantMigration(sql);
  await applyRoutineMigration(sql);
  const grants = createPostgresGrantStore(sql);
  const routines = createPostgresRoutineStore(sql);
  let service: RoutineService | undefined;
  return {
    guard: (base) => async (spec) => {
      const current = await base(spec);
      return service === undefined
        ? { ...current, active: false }
        : service.guardSponsorAuthority(() => Promise.resolve(current))(spec);
    },
    bind(scheduler) {
      service = createRoutineService({
        grants,
        routines,
        schedules: createRoutineSchedules(scheduler),
        activation,
        now,
      });
      return service;
    },
  };
}
