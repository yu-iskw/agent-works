import { IAP_ASSERTION_HEADER } from '@agent-works/domain';
import { ZodError } from 'zod';

import { Unauthenticated } from '../auth/iap.js';
import { headerValue } from '../http.js';
import { GovernanceConflict } from '../ports/governance.js';

import type { VerifyAssertion } from '../auth/iap.js';
import type { Route } from '../http.js';
import type { GovernancePort } from '../ports/governance.js';

export type GovernanceDeps = {
  readonly verify: VerifyAssertion;
  /** Only a trusted directory resolver may provide roles. Headers and bodies are ignored. */
  readonly rolesFor: (subject: string) => Promise<readonly string[]>;
  readonly port: GovernancePort;
  readonly now: () => Date;
};
export function requireGovernanceRole(
  deps: GovernanceDeps,
  operation: (actor: string, request: Parameters<Route>[0]) => ReturnType<Route>,
): Route {
  return async (request) => {
    try {
      const caller = await deps.verify(headerValue(request.headers, IAP_ASSERTION_HEADER));
      const roles = await deps.rolesFor(caller.sub);
      if (!roles.some((role) => ['Admin', 'admin', 'privacy-officer'].includes(role)))
        return { status: 403, body: { error: 'forbidden' } };
      return await operation(caller.sub, request);
    } catch (error) {
      if (error instanceof Unauthenticated)
        return { status: 401, body: { error: 'unauthenticated' } };
      if (error instanceof ZodError || error instanceof SyntaxError)
        return { status: 400, body: { error: 'invalid_governance_command' } };
      if (error instanceof GovernanceConflict)
        return { status: 409, body: { error: 'governance_conflict' } };
      return { status: 503, body: { error: 'governance_unavailable' } };
    }
  };
}
export function parseGovernanceBody(request: Parameters<Route>[0]): unknown {
  if (request.body.length > 16384) throw new SyntaxError('body too large');
  return JSON.parse(request.body.toString('utf8')) as unknown;
}
