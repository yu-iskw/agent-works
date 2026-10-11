import { approvalsReadMatch } from './approvals.js';
import { notImplementedRoute } from './not-implemented.js';

import type { PatternSlot } from './slot.js';

export const approvalsReadSlot: PatternSlot = {
  id: 'approvals-read',
  env: 'AW_APPROVALS',
  method: 'GET',
  match: approvalsReadMatch,
  kind: 'pattern',
  stub: notImplementedRoute,
};
