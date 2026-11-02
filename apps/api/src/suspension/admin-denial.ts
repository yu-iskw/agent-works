import { randomUUID } from 'node:crypto';

import { canonicalPayloadSha256, IAP_ASSERTION_HEADER } from '@agent-works/domain';

import { headerValue } from '../http.js';

import type { Route } from '../http.js';
import type { SuspensionAudit } from '../ports/suspension-ledger.js';
import type { AdminDeps } from '../routes/admin-auth.js';

export const adminRoleRequired = 'ADMIN_ROLE_REQUIRED';

/**
 * Records who tried an admin route without the Admin role and what they attempted.
 * The 403 reply and the unchanged suspension state are the denial; the audit write is best effort
 * and can never turn a denial into an allow.
 */
export function auditAdminDenials(
  routes: Readonly<Record<string, Route>>,
  deps: Pick<AdminDeps, 'verify' | 'ledger' | 'now'>,
): Readonly<Record<string, Route>> {
  return Object.fromEntries(
    Object.entries(routes).map(([name, route]): [string, Route] => [
      name,
      async (request) => {
        const reply = await route(request);
        if (reply.status === 403) await record(deps, name, request);
        return reply;
      },
    ]),
  );
}
async function record(
  deps: Pick<AdminDeps, 'verify' | 'ledger' | 'now'>,
  route: string,
  request: Parameters<Route>[0],
): Promise<void> {
  try {
    const caller = await deps.verify(headerValue(request.headers, IAP_ASSERTION_HEADER));
    const attempted = attemptedChange(request.body);
    const eventId = randomUUID();
    const event: SuspensionAudit = {
      eventId,
      eventType: 'invocation.denied',
      actorSub: caller.sub,
      occurredAt: deps.now().toISOString(),
      reason: adminRoleRequired,
      digest: canonicalPayloadSha256({ route, actor: caller.sub, attempted }),
      taskId: null,
      traceId: eventId,
      details: { kind: 'admin', route, attempted },
    };
    await deps.ledger.deny(event);
  } catch {
    /* The request is already denied; an unavailable audit store must not alter that. */
  }
}
function attemptedChange(body: Buffer): { action: string | null; target: string | null } {
  try {
    const value = JSON.parse(body.toString('utf8')) as {
      action?: unknown;
      target?: { scope?: unknown; id?: unknown };
    };
    return {
      action: typeof value.action === 'string' ? value.action : null,
      target:
        typeof value.target?.scope === 'string' && typeof value.target.id === 'string'
          ? `${value.target.scope}:${value.target.id}`
          : null,
    };
  } catch {
    return { action: null, target: null };
  }
}
