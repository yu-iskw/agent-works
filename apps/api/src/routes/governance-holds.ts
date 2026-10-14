import { holdCommandSchema } from '@agent-works/domain/data-governance';

import { changeLegalHold } from '../governance/holds.js';

import { parseGovernanceBody, requireGovernanceRole } from './governance-auth.js';

import type { GovernanceDeps } from './governance-auth.js';
import type { Route } from '../http.js';

export function governanceHoldRoutes(deps: GovernanceDeps): Readonly<Record<string, Route>> {
  return {
    'GET /v1/admin/governance/holds': requireGovernanceRole(deps, async () => ({
      status: 200,
      body: { holds: (await deps.port.snapshot()).holds },
    })),
    'POST /v1/admin/governance/holds': requireGovernanceRole(deps, async (actor, request) => {
      const command = holdCommandSchema.parse(parseGovernanceBody(request));
      return { status: 200, body: await changeLegalHold(deps.port, command, actor, deps.now()) };
    }),
  };
}
