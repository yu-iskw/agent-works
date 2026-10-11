import { notImplementedRoute } from './not-implemented.js';

import type { ExactSlot } from './slot.js';

export const searchSlot: ExactSlot = {
  id: 'search',
  env: 'AW_SEARCH',
  method: 'POST',
  path: '/v1/search',
  kind: 'exact',
  stub: notImplementedRoute,
};
