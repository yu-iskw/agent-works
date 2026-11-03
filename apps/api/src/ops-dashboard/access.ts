import { OpsDenied } from './types.js';

import type { OpsPrincipal, OpsScope } from './types.js';

/** An omitted scope means the caller's own member scope. Anything else must be granted. */
export function authorizeScope(principal: OpsPrincipal, requested?: OpsScope): OpsScope {
  const scope = requested ?? { kind: 'member', id: principal.memberId };
  if (principal.platformAdmin) return scope;
  const allowed =
    (scope.kind === 'member' && scope.id === principal.memberId) ||
    (scope.kind === 'bot' && principal.ownedBotIds.includes(scope.id)) ||
    (scope.kind === 'segment' && principal.adminSegmentIds.includes(scope.id));
  if (!allowed || scope.id === '') throw new OpsDenied();
  return scope;
}
