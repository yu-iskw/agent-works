import { resolveAuthority } from '../broker/authority.js';
import { InvocationStopped } from '../suspension/enforcement.js';

import { EffectDenied, WorkerFailure } from './types.js';

import type { EffectGate, EffectSpec } from './effects.js';
import type { AuthorityRequest, AuthorityResolver } from '../broker/authority.js';
import type { SuspensionEnforcer } from '../suspension/enforcement.js';
import type { InvocationContext } from '@agent-works/policy';

export type EffectIdentity = {
  readonly authority: AuthorityRequest;
  readonly invocation: InvocationContext;
};

/**
 * The per-effect SEC-03 recheck. It adds no authority logic: the broker's `resolveAuthority`
 * decides grant, membership and connector state, and the suspension enforcer decides
 * revoke, pause and suspension. Denial is permanent for this execution; an unreadable
 * authority or suspension store fails closed and retryable.
 */
export function createAuthorityEffectGate(deps: {
  readonly resolver: AuthorityResolver;
  readonly enforcer: SuspensionEnforcer;
  readonly identify: (executionId: string, effect: EffectSpec) => Promise<EffectIdentity>;
  readonly now?: () => Date;
}): EffectGate {
  const now = deps.now ?? (() => new Date());
  return {
    async check(executionId, effect) {
      const identity = await deps.identify(executionId, effect);
      const verdict = await resolveAuthority(deps.resolver, identity.authority, now());
      if (!verdict.ok) {
        if (verdict.code === 'AUTHORITY_DENIED') throw new EffectDenied('authority-denied');
        throw new WorkerFailure('retryable', 'authority-unavailable');
      }
      try {
        await deps.enforcer.check(identity.invocation, 'tool');
      } catch (error) {
        if (error instanceof InvocationStopped) {
          if (error.code === 'SUSPENSION_STORE_UNAVAILABLE') {
            throw new WorkerFailure('retryable', 'suspension-unavailable');
          }
          throw new EffectDenied(error.code.toLowerCase().replaceAll('_', '-'));
        }
        throw new WorkerFailure('retryable', 'suspension-unavailable');
      }
    },
  };
}
