import { notImplementedRoute } from './not-implemented.js';

import type { PatternSlot } from './slot.js';

export const oauthConnectSlot: PatternSlot = {
  id: 'oauth-connect',
  env: 'AW_OAUTH_CONNECT',
  method: 'POST',
  match: /^\/v1\/oauth\/connections\/([^/]+)$/,
  kind: 'pattern',
  stub: notImplementedRoute,
};
