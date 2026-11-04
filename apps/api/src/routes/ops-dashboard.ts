import { IAP_ASSERTION_HEADER } from '@agent-works/domain';
import * as z from 'zod';

import { Unauthenticated } from '../auth/iap.js';
import { headerValue } from '../http.js';
import { OpsDenied } from '../ops-dashboard/types.js';

import type { VerifyAssertion } from '../auth/iap.js';
import type { Route } from '../http.js';
import type { OpsDashboardService } from '../ops-dashboard/service.js';
import type { OpsPrincipal } from '../ops-dashboard/types.js';

export type OpsDashboardRouteDeps = {
  readonly verify: VerifyAssertion;
  /** Server-side grants for a verified subject. The request never supplies them. */
  readonly authority: (subject: string) => Promise<Omit<OpsPrincipal, 'subject'>>;
  readonly service: OpsDashboardService;
};

const bodySchema = z.strictObject({
  scope: z
    .strictObject({ kind: z.enum(['member', 'bot', 'segment', 'all']), id: z.string().max(200) })
    .optional(),
  from: z.iso.datetime().optional(),
  to: z.iso.datetime().optional(),
});

function parseBody(body: Buffer): z.infer<typeof bodySchema> {
  if (body.length === 0) return {};
  return bodySchema.parse(JSON.parse(body.toString('utf8')));
}

function guarded(
  deps: OpsDashboardRouteDeps,
  operation: (principal: OpsPrincipal, request: z.infer<typeof bodySchema>) => Promise<unknown>,
): Route {
  return async (request) => {
    try {
      const caller = await deps.verify(headerValue(request.headers, IAP_ASSERTION_HEADER));
      const principal = { ...(await deps.authority(caller.sub)), subject: caller.sub };
      return { status: 200, body: await operation(principal, parseBody(request.body)) };
    } catch (error) {
      if (error instanceof Unauthenticated)
        return { status: 401, body: { error: 'unauthenticated' } };
      if (error instanceof OpsDenied) return { status: 403, body: { error: 'forbidden_scope' } };
      if (error instanceof z.ZodError || error instanceof SyntaxError)
        return { status: 400, body: { error: 'invalid_ops_request' } };
      return { status: 503, body: { error: 'ops_dashboard_unavailable' } };
    }
  };
}

/** Wiring: mount the returned record in the route table. Read-only; both routes use POST for the body. */
export function opsDashboardRoutes(deps: OpsDashboardRouteDeps): Record<string, Route> {
  return {
    'POST /v1/ops/dashboard': guarded(deps, async (principal, body) => ({
      dashboard: await deps.service.view(principal, body.scope, body),
    })),
    'POST /v1/ops/dashboard/reconcile': guarded(deps, (principal, body) =>
      deps.service.reconcile(principal, body.scope, body),
    ),
  };
}
