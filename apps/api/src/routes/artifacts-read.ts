import { notImplementedRoute } from './not-implemented.js';

import type { PatternSlot } from './slot.js';

export const artifactsReadSlot: PatternSlot = {
  id: 'artifacts-read',
  env: 'AW_ARTIFACTS',
  method: 'GET',
  match: /^\/v1\/artifacts\/([^/]+)$/,
  kind: 'pattern',
  stub: notImplementedRoute,
};
