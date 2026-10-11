import { approvalsDecideSlot } from './approvals-decide.js';
import { artifactsReadSlot } from './artifacts-read.js';
import { createAskRoute } from './ask.js';
import { oauthConnectSlot } from './oauth-connect.js';
import { oauthRevokeSlot } from './oauth-revoke.js';
import { searchSlot } from './search.js';
import { skillsListSlot } from './skills-list.js';
import { selectRoute } from './slot.js';
import { tasksCancelSlot } from './tasks-cancel.js';
import { tasksEventsSlot } from './tasks-events.js';
import { tasksReadSlot } from './tasks-read.js';
import { tasksSubmitSlot } from './tasks-submit.js';

import type { Route } from '../http.js';
import type { AskDeps } from './ask.js';
import type { PatternSlot, RouteEnv } from './slot.js';

const patternSlots: readonly PatternSlot[] = [
  tasksEventsSlot,
  tasksCancelSlot,
  tasksReadSlot,
  approvalsDecideSlot,
  artifactsReadSlot,
  oauthConnectSlot,
  oauthRevokeSlot,
];

const exactSlots = [searchSlot, tasksSubmitSlot, skillsListSlot];

export function createRouteTable(deps: AskDeps, env: RouteEnv): Readonly<Record<string, Route>> {
  const table: Record<string, Route> = {
    'POST /v1/ask': createAskRoute(deps),
  };
  for (const slot of exactSlots) {
    table[`${slot.method} ${slot.path}`] = selectRoute(slot, env);
  }
  return table;
}

export function matchSlot(method: string, pathname: string): PatternSlot | undefined {
  return patternSlots.find((slot) => slot.method === method && slot.match.test(pathname));
}
