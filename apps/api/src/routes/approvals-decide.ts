import { approvalsDecideMatch } from './approvals.js';
import { notImplementedRoute } from './not-implemented.js';

import type { PatternSlot } from './slot.js';

export const approvalsDecideSlot: PatternSlot = {
  id: 'approvals-decide',
  env: 'AW_APPROVALS',
  method: 'POST',
  match: approvalsDecideMatch,
  kind: 'pattern',
  stub: notImplementedRoute,
};
