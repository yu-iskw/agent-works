import { notImplementedRoute } from './not-implemented.js';

import type { PatternSlot } from './slot.js';

export const tasksEventsSlot: PatternSlot = {
  id: 'tasks-events',
  env: 'AW_TASKS_EVENTS',
  method: 'GET',
  match: /^\/v1\/tasks\/([^/]+)\/events$/,
  kind: 'pattern',
  stub: notImplementedRoute,
};
