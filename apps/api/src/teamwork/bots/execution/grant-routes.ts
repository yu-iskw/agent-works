import { TEAMWORK_API_VERSION, UUID_PATTERN } from '@agent-works/domain/teamwork';
import * as z from 'zod';

import { createGrantLifecycle } from '../../../authority-lifecycle/lifecycle.js';
import { Conflict } from '../../context.js';
import { requireOwner } from '../store.js';

import { executionRoute, requestBody } from './run-routes.js';
import { bindOwner } from './views.js';

import type { ExecutionOptions } from './types.js';
import type { BotRoute } from '../routes.js';
import type { StandingGrant } from '@agent-works/domain/standing-grant-contract';

const view = (grant: StandingGrant) => ({
  grantId: grant.grantId,
  revision: grant.grantee.botVersion,
  expiresAt: grant.expiresAt,
  revokedAt: grant.revocation.status === 'revoked' ? grant.revocation.revokedAt : null,
  maxRuns: grant.limits.budget.inferenceSteps,
  budgetMicros:
    grant.limits.budget.estimatedCostMicros === Number.MAX_SAFE_INTEGER
      ? null
      : grant.limits.budget.estimatedCostMicros,
});
export function createBotGrantRoutes(options: ExecutionOptions): readonly BotRoute[] {
  const { deps } = options;
  const lifecycle = createGrantLifecycle({
    store: options.grants,
    activation: { enabled: true },
    now: deps.now,
    newId: deps.newId,
    policyRevision: TEAMWORK_API_VERSION,
  });
  const path = `bots/(${UUID_PATTERN})/grants`;
  return [
    executionRoute(
      options,
      'POST',
      path,
      async (member, request, [id]) => {
        await requireOwner(deps.sql, member, id);
        await bindOwner(options, member, id);
        const input = requestBody(
          z.strictObject({
            revision: z.number().int().positive(),
            expiresAt: z.iso.datetime(),
            maxRuns: z.number().int().min(1).max(1000),
            budgetMicros: z.number().int().nonnegative().safe().nullable(),
          }),
          request,
        );
        const pin = await options.service.pinForRun(id);
        if (pin.revision !== input.revision) throw new Conflict('stale_confirmation');
        const result = await lifecycle.issueRoot(
          { kind: 'human', sub: member.sub, role: 'owner' },
          {
            sponsor: member.sub,
            grantee: { botId: id, botVersion: pin.revision },
            permissions: [{ action: 'bot.run', resource: pin.digest }],
            expiresAt: input.expiresAt,
            maxDepth: 0,
            schedule: {
              allowed: true,
              minIntervalSeconds: 0,
              maxLifetimeSeconds: Math.max(
                0,
                Math.floor((Date.parse(input.expiresAt) - deps.now().getTime()) / 1000),
              ),
              maxActiveRoutines: 1,
            },
            limits: {
              maxConcurrency: pin.definition.limits.maxConcurrentRunsPerBot,
              maxFanOut: 0,
              budget: {
                approval: 'PLACEHOLDER',
                estimatedCostMicros: input.budgetMicros ?? Number.MAX_SAFE_INTEGER,
                inferenceSteps: input.maxRuns,
                parallelism: pin.definition.limits.maxConcurrentRunsPerBot,
              },
            },
          },
        );
        if (!result.ok) throw new Conflict('invalid_grant', 400);
        return { grant: view(result.grant) };
      },
      201,
    ),
    executionRoute(options, 'GET', path, async (member, _request, [id]) => {
      await requireOwner(deps.sql, member, id);
      return {
        grants: (await options.grants.list({ sponsor: member.sub }))
          .filter((g) => g.grantee.botId === id)
          .map(view),
      };
    }),
    executionRoute(
      options,
      'POST',
      `${path}/(${UUID_PATTERN})/revoke`,
      async (member, request, [id, grantId]) => {
        requestBody(z.strictObject({}), request);
        await requireOwner(deps.sql, member, id);
        await bindOwner(options, member, id);
        const grant = await options.grants.get(grantId);
        if (!grant || grant.sponsor !== member.sub || grant.grantee.botId !== id)
          throw new Conflict('not_found', 404);
        await lifecycle.revoke(
          { kind: 'human', sub: member.sub, role: 'owner' },
          grantId,
          'owner_revoked',
        );
        const updated = await options.grants.get(grantId);
        if (!updated) throw new Conflict('not_found', 404);
        return { grant: view(updated) };
      },
    ),
  ];
}
