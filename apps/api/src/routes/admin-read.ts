import { requireAdmin } from './admin-auth.js';

import type { AdminDeps } from './admin-auth.js';
import type { Route } from '../http.js';

export function adminReadRoutes(deps: AdminDeps): Readonly<Record<string, Route>> {
  return {
    'GET /v1/admin/suspensions': requireAdmin(deps, async () => ({
      status: 200,
      body: await deps.ledger.snapshot(),
    })),
    'GET /v1/admin/history': requireAdmin(deps, async () => ({
      status: 200,
      body: { events: await deps.ledger.history() },
    })),
  };
}
