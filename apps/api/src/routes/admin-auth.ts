import { IAP_ASSERTION_HEADER } from '@agent-works/domain';

import { Unauthenticated } from '../auth/iap.js';
import { headerValue } from '../http.js';

import type { AppRole } from '../auth/directory.js';
import type { VerifyAssertion } from '../auth/iap.js';
import type { Route } from '../http.js';
import type { SuspensionLedger } from '../ports/suspension-ledger.js';

export type AdminDeps = {
  readonly verify: VerifyAssertion;
  readonly rolesFor: (sub: string) => Promise<readonly AppRole[]>;
  readonly ledger: SuspensionLedger;
  readonly now: () => Date;
};
export function requireAdmin(
  deps: AdminDeps,
  operation: (subject: string, request: Parameters<Route>[0]) => ReturnType<Route>,
): Route {
  return async (request) => {
    try {
      const caller = await deps.verify(headerValue(request.headers, IAP_ASSERTION_HEADER));
      const roles = await deps.rolesFor(caller.sub);
      if (!roles.includes('Admin')) return { status: 403, body: { error: 'forbidden' } };
      return await operation(caller.sub, request);
    } catch (error) {
      if (error instanceof Unauthenticated)
        return { status: 401, body: { error: 'unauthenticated' } };
      return { status: 503, body: { error: 'suspension_store_unavailable' } };
    }
  };
}
