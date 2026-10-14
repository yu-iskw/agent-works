import { createMemoryGovernancePort } from '../ports/memory/governance.js';

import { governanceDeletionRoutes } from './governance-deletions.js';
import { governanceHoldRoutes } from './governance-holds.js';

import type { GovernanceDeps } from './governance-auth.js';
import type { VerifyAssertion } from '../auth/iap.js';
import type { Route } from '../http.js';

export type GovernanceRegistration = {
  readonly verify: VerifyAssertion;
  readonly now: () => Date;
  readonly governance?: Omit<GovernanceDeps, 'verify' | 'now'>;
  readonly admin?: { readonly rolesFor: GovernanceDeps['rolesFor'] };
};
/** Explicit governance injection enables durable ports; existing trusted admin
 * registration gets an isolated local store for this offline bundle. */
export function governanceRoutes(
  registration: GovernanceRegistration,
): Readonly<Record<string, Route>> {
  const deps =
    registration.governance ??
    (registration.admin === undefined
      ? undefined
      : { rolesFor: registration.admin.rolesFor, port: createMemoryGovernancePort() });
  if (deps === undefined) return {};
  const full = { ...deps, verify: registration.verify, now: registration.now };
  return { ...governanceHoldRoutes(full), ...governanceDeletionRoutes(full) };
}
