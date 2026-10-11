import { notImplementedRoute } from './not-implemented.js';

import type { ExactSlot } from './slot.js';

export const skillsListSlot: ExactSlot = {
  id: 'skills-list',
  env: 'AW_SKILLS',
  method: 'GET',
  path: '/v1/skills',
  kind: 'exact',
  stub: notImplementedRoute,
};
