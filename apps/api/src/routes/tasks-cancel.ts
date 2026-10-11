import { notImplementedRoute } from './not-implemented.js';

import type { PatternSlot } from './slot.js';

export const tasksCancelSlot: PatternSlot = {
  id: 'tasks-cancel',
  env: 'AW_TASKS_CANCEL',
  method: 'POST',
  match: /^\/v1\/tasks\/([^/]+):cancel$/,
  kind: 'pattern',
  stub: notImplementedRoute,
};
