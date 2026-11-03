import { analyticsRoutes } from '../analytics/registration.js';
import { createMemoryTaskPorts } from '../ports/memory/task-ports.js';
import { auditAdminDenials } from '../suspension/admin-denial.js';

import { adminChangeRoutes } from './admin-change.js';
import { requireAdmin } from './admin-auth.js';
import { adminReadRoutes } from './admin-read.js';
import { approvalsDecideSlot } from './approvals-decide.js';
import { approvalsReadSlot } from './approvals-read.js';
import { artifactsReadSlot } from './artifacts-read.js';
import { createAskRoute } from './ask.js';
import { eventsIngestRoutes } from './events-ingest.js';
import { governanceRoutes } from './governance-routes.js';
import { memoryRoutes } from './memory-routes.js';
import { oauthConnectSlot } from './oauth-connect.js';
import { createOAuthConnectionsReadRoute } from './oauth-connections-read.js';
import { oauthRevokeSlot } from './oauth-revoke.js';
import { opsDashboardRoutes } from './ops-dashboard.js';
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
import type { AnalyticsRouteDeps } from './analytics-auth.js';
import type { AskDeps } from './ask.js';
import type { OpsDashboardRouteDeps } from './ops-dashboard.js';
import type { ScheduleRouteDeps } from './schedules-auth.js';
import type { Route } from '../http.js';
import type { GovernanceRegistration } from './governance-routes.js';
import type { MemoryRouteDeps } from './memory-auth.js';
import type { OAuthConnectionsReadDeps } from './oauth-connections-read.js';
import type { PatternSlot, RouteEnv } from './slot.js';
import type { TaskRoutes } from './tasks.js';
import type { DispatchPort } from '../ports/dispatch-port.js';
import type { EventIngestor } from '../scheduling/ingestion.js';
import type { SkillRegistry } from '../skills/registry.js';
import type { OutstandingReport } from '../suspension/outstanding.js';
import type { Telemetry } from '../telemetry/instrument.js';

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
  readonly connectors?: Readonly<Record<string, Route>>;
  readonly analytics?: AnalyticsRouteDeps;
  readonly userMemory?: MemoryRouteDeps;
  readonly governance?: GovernanceRegistration['governance'];
  readonly schedules?: ScheduleRouteDeps;
  readonly scheduleEvents?: EventIngestor;
  readonly admin?: Omit<AdminDeps, 'verify'>;
  readonly tasks?: TaskRoutes;
  readonly dispatch?: DispatchPort;
  readonly skills?: SkillRegistry;
  readonly oauthConnections?: Omit<OAuthConnectionsReadDeps, 'verify'>;
  /** Mounts `GET /v1/admin/outstanding` for an Admin; needs `admin`. */
  readonly outstanding?: () => Promise<OutstandingReport>;
  readonly opsDashboard?: OpsDashboardRouteDeps;
  /** Service-to-service routes that carry their own authentication, outside the IAP table. */
  readonly internal?: Readonly<Record<string, Route>>;
  readonly telemetry?: Telemetry;
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
  if (deps.admin !== undefined) {
    const admin = { ...deps.admin, verify: deps.verify };
    const { outstanding } = deps;
    Object.assign(
      table,
      auditAdminDenials(
        {
          ...adminReadRoutes(admin),
          ...adminChangeRoutes(admin),
          ...(outstanding === undefined
            ? {}
            : {
                'GET /v1/admin/outstanding': requireAdmin(admin, async () => ({
                  status: 200,
                  body: await outstanding(),
                })),
              }),
        },
        admin,
      ),
    );
  }
  if (deps.opsDashboard !== undefined) Object.assign(table, opsDashboardRoutes(deps.opsDashboard));
  if (deps.internal !== undefined) Object.assign(table, deps.internal);
  Object.assign(
    table,
    governanceRoutes(deps),
    deps.connectors,
    analyticsRoutes(deps.analytics),
    memoryRoutes(deps.userMemory),
  );
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
