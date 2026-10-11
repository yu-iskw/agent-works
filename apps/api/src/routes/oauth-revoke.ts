import { notImplementedRoute } from './not-implemented.js';

import type { PatternSlot } from './slot.js';

export const oauthRevokeSlot: PatternSlot = {
  id: 'oauth-revoke',
  env: 'AW_OAUTH_REVOKE',
  method: 'DELETE',
  match: /^\/v1\/oauth\/connections\/([^/]+)$/,
  kind: 'pattern',
  stub: notImplementedRoute,
};
