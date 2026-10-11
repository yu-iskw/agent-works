import { createMemoryLedgerPort } from '../ports/memory/ledger-port.js';

import { approvalsDecideSlot } from './approvals-decide.js';
import { approvalsReadSlot } from './approvals-read.js';
import { artifactsReadSlot } from './artifacts-read.js';
import { createAskRoute } from './ask.js';
import { oauthConnectSlot } from './oauth-connect.js';
import { oauthRevokeSlot } from './oauth-revoke.js';
import { searchSlot } from './search.js';
import { createSkillsListRoute, skillsListSlot } from './skills-list.js';
import { selectRoute } from './slot.js';
import { tasksCancelSlot } from './tasks-cancel.js';
import { tasksEventsSlot } from './tasks-events.js';
import { tasksReadSlot } from './tasks-read.js';
import { tasksSubmitSlot } from './tasks-submit.js';
import { createTaskRoutes } from './tasks.js';

import type { Route } from '../http.js';
import type { AskDeps } from './ask.js';
import type { PatternSlot, RouteEnv } from './slot.js';
import type { TaskRoutes } from './tasks.js';
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

export type RouteDeps = AskDeps & { readonly tasks?: TaskRoutes; readonly skills?: SkillRegistry };

export function createRouteTable(deps: RouteDeps, env: RouteEnv): Readonly<Record<string, Route>> {
  const table: Record<string, Route> = {
    'POST /v1/ask': createAskRoute(deps),
  };
  const tasks =
    deps.tasks ??
    createTaskRoutes(deps.wire?.ledger ?? createMemoryLedgerPort(), deps.verify, deps.skills, deps);
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
