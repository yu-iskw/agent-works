import { createMemoryTaskPorts } from '../ports/memory/task-ports.js';

import { adminChangeRoutes } from './admin-change.js';
import { adminReadRoutes } from './admin-read.js';
import { approvalsDecideSlot } from './approvals-decide.js';
import { approvalsReadSlot } from './approvals-read.js';
import { artifactsReadSlot } from './artifacts-read.js';
import { createAskRoute } from './ask.js';
import { eventsIngestRoutes } from './events-ingest.js';
import { governanceRoutes } from './governance-routes.js';
import { oauthConnectSlot } from './oauth-connect.js';
import { createOAuthConnectionsReadRoute } from './oauth-connections-read.js';
import { oauthRevokeSlot } from './oauth-revoke.js';
import { schedulesChangeRoutes } from './schedules-change.js';
import { schedulesCreateRoutes } from './schedules-create.js';
import { schedulesReadRoutes } from './schedules-read.js';
import { schedulesRunRoutes } from './schedules-runs.js';
import { searchSlot } from './search.js';
import { createSkillsListRoute, skillsListSlot } from './skills-list.js';
import { selectRoute } from './slot.js';
import { tasksCancelSlot } from './tasks-cancel.js';
import { tasksEventsSlot } from './tasks-events.js';
import { tasksReadSlot } from './tasks-read.js';
import { tasksSubmitSlot } from './tasks-submit.js';
import { createTaskRoutes } from './tasks.js';

import type { AdminDeps } from './admin-auth.js';
import type { ScheduleRouteDeps } from './schedules-auth.js';
import type { Route } from '../http.js';
import type { AskDeps } from './ask.js';
import type { OAuthConnectionsReadDeps } from './oauth-connections-read.js';
import type { PatternSlot, RouteEnv } from './slot.js';
import type { TaskRoutes } from './tasks.js';
import type { DispatchPort } from '../ports/dispatch-port.js';
import type { EventIngestor } from '../scheduling/ingestion.js';
import type { SkillRegistry } from '../skills/registry.js';

const patternSlots: readonly PatternSlot[] = [
  tasksEventsSlot,
  tasksCancelSlot,
  tasksReadSlot,
  approvalsDecideSlot,
  approvalsReadSlot,
  artifactsReadSlot,
  oauthConnectSlot,
  oauthRevokeSlot,
];

const exactSlots = [searchSlot, tasksSubmitSlot, skillsListSlot];

export type RouteDeps = AskDeps & {
  readonly schedules?: ScheduleRouteDeps;
  readonly scheduleEvents?: EventIngestor;
  readonly admin?: Omit<AdminDeps, 'verify'>;
  readonly tasks?: TaskRoutes;
  readonly dispatch?: DispatchPort;
  readonly skills?: SkillRegistry;
  readonly oauthConnections?: Omit<OAuthConnectionsReadDeps, 'verify'>;
};

export function createRouteTable(deps: RouteDeps, env: RouteEnv): Readonly<Record<string, Route>> {
  const table: Record<string, Route> = {
    'POST /v1/ask': createAskRoute(deps),
  };
  if (deps.schedules !== undefined)
    Object.assign(
      table,
      schedulesReadRoutes(deps.schedules),
      schedulesCreateRoutes(deps.schedules),
      schedulesChangeRoutes(deps.schedules),
      schedulesRunRoutes(deps.schedules),
    );
  if (deps.scheduleEvents !== undefined)
    Object.assign(table, eventsIngestRoutes(deps.scheduleEvents));
  if (deps.oauthConnections !== undefined) {
    table['GET /v1/oauth/connections'] = createOAuthConnectionsReadRoute({
      ...deps.oauthConnections,
      verify: deps.verify,
    });
  }
  if (deps.admin !== undefined)
    Object.assign(
      table,
      adminReadRoutes({ ...deps.admin, verify: deps.verify }),
      adminChangeRoutes({ ...deps.admin, verify: deps.verify }),
    );
  Object.assign(table, governanceRoutes(deps));
  const memory = createMemoryTaskPorts(deps.now);
  const tasks =
    deps.tasks ??
    createTaskRoutes(
      deps.dispatch === undefined ? memory.ledger : (deps.wire?.ledger ?? memory.ledger),
      deps.verify,
      deps.skills,
      deps,
      deps.dispatch ?? memory.dispatch,
    );
  const routes = new Map<string, Route>([
    ['skills-list', createSkillsListRoute(deps.verify, deps.skills)],
    ['tasks-submit', tasks.submit],
  ]);
  for (const slot of exactSlots) {
    const real = routes.get(slot.id) ?? slot.real;
    const selected = real === undefined ? slot : { ...slot, real };
    table[`${slot.method} ${slot.path}`] = selectRoute(selected, env);
  }
  return table;
}

export function matchSlot(method: string, pathname: string): PatternSlot | undefined {
  return patternSlots.find((slot) => slot.method === method && slot.match.test(pathname));
}
