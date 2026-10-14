import * as z from 'zod';

import { processDeletion, requestDeletion } from '../governance/deletion-requests.js';
import { deletionCommandSchema } from '../governance/model.js';

import { parseGovernanceBody, requireGovernanceRole } from './governance-auth.js';

import type { GovernanceDeps } from './governance-auth.js';
import type { Route } from '../http.js';

const processSchema = z.strictObject({ requestId: z.uuid() });
export function governanceDeletionRoutes(deps: GovernanceDeps): Readonly<Record<string, Route>> {
  return {
    'GET /v1/admin/governance/deletions': requireGovernanceRole(deps, async () => ({
      status: 200,
      body: { requests: (await deps.port.snapshot()).requests },
    })),
    'POST /v1/admin/governance/deletions': requireGovernanceRole(deps, async (actor, request) => {
      const command = deletionCommandSchema.parse(parseGovernanceBody(request));
      return { status: 202, body: await requestDeletion(deps.port, command, actor, deps.now()) };
    }),
    'POST /v1/admin/governance/deletions/process': requireGovernanceRole(
      deps,
      async (actor, request) => {
        const command = processSchema.parse(parseGovernanceBody(request));
        return {
          status: 200,
          body: await processDeletion(deps.port, command.requestId, actor, deps.now()),
        };
      },
    ),
  };
}
