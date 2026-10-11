import { notImplementedRoute } from './not-implemented.js';

import type { ExactSlot } from './slot.js';

export const tasksSubmitSlot: ExactSlot = {
  id: 'tasks-submit',
  env: 'AW_TASKS',
  method: 'POST',
  path: '/v1/tasks',
  kind: 'exact',
  stub: notImplementedRoute,
};
