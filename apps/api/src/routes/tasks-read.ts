import { notImplementedRoute } from './not-implemented.js';
import { taskReadRoute } from './tasks.js';

import type { PatternSlot } from './slot.js';

export const tasksReadSlot: PatternSlot = {
  id: 'tasks-read',
  env: 'AW_TASKS_READ',
  method: 'GET',
  match: /^\/v1\/tasks\/([^/]+)$/,
  kind: 'pattern',
  stub: notImplementedRoute,
  real: taskReadRoute,
};
