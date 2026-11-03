import { readDispatchEnvelope } from '@agent-works/domain';

import { AuthorizationDenied, Unauthenticated, Unavailable } from '../auth/iap.js';
import { verifyServiceClaims } from '../auth/service-identity.js';

import type { VerifyIdToken } from './rs256-jwks-verifier.js';
import type { ServiceCaller, ServiceIdentityPolicy } from '../auth/service-identity.js';
import type { DispatchEnvelopeV1 } from '@agent-works/domain';

/** Result of the durable handoff, decided by the database and never by the payload. */
export type HandoffOutcome = 'accepted' | 'already-terminal' | 'in-progress' | 'unknown-execution';

export type DeliveryStore = {
  /**
   * Resolves `executionId` in the database and durably commits the handoff (lease claim or
   * work-queue row) before resolving. Must not start work that outlives the returned promise.
   */
  handoff(input: {
    readonly envelope: DispatchEnvelopeV1;
    readonly caller: ServiceCaller;
  }): Promise<HandoffOutcome>;
  /** Durable record of a permanently rejected delivery (error class only, never the body). */
  recordRejected(input: { readonly reason: string; readonly caller: ServiceCaller }): Promise<void>;
};

export type DeliveryRequest = {
  readonly authorization: string | undefined;
  readonly body: string | Uint8Array;
};

export type DeliveryResponse = {
  readonly status: 200 | 401 | 403 | 503;
  readonly outcome: string;
};

export type DeliveryDeps = {
  readonly verifyIdToken: VerifyIdToken;
  readonly policy: ServiceIdentityPolicy;
  readonly store: DeliveryStore;
  readonly now?: () => number;
};

const reply = (status: DeliveryResponse['status'], outcome: string): DeliveryResponse => ({
  status,
  outcome,
});

/**
 * Cloud Tasks treats any 2xx as done and retries everything else, so 2xx is returned only
 * after the durable handoff committed, for a delivery whose execution is already terminal, or
 * for a poison message after its rejection was recorded. Everything retryable is a 503.
 */
export function createDeliveryHandler(
  deps: DeliveryDeps,
): (request: DeliveryRequest) => Promise<DeliveryResponse> {
  const clock = deps.now ?? Date.now;
  return async (request) => {
    const authenticated = await authenticate(deps, request.authorization, clock());
    if ('status' in authenticated) return authenticated;
    const { caller } = authenticated;

    const read = readDispatchEnvelope(request.body);
    if (!read.ok) {
      if (read.retryable) return reply(503, read.reason);
      try {
        await deps.store.recordRejected({ reason: read.reason, caller });
      } catch {
        return reply(503, 'record-failed');
      }
      return reply(200, `rejected:${read.reason}`);
    }

    let outcome: HandoffOutcome;
    try {
      outcome = await deps.store.handoff({ envelope: read.envelope, caller });
    } catch {
      return reply(503, 'handoff-failed');
    }
    switch (outcome) {
      case 'accepted':
        return reply(200, 'accepted');
      case 'already-terminal':
        return reply(200, 'already-terminal');
      case 'in-progress':
        return reply(503, 'in-progress');
      case 'unknown-execution':
        return reply(503, 'unknown-execution');
    }
  };
}

async function authenticate(
  deps: DeliveryDeps,
  authorization: string | undefined,
  nowMs: number,
): Promise<{ readonly caller: ServiceCaller } | DeliveryResponse> {
  const match = authorization === undefined ? null : /^Bearer (\S+)$/i.exec(authorization);
  if (match?.[1] === undefined) return reply(401, 'unauthenticated');
  try {
    const claims = await deps.verifyIdToken(match[1]);
    return { caller: verifyServiceClaims(claims, deps.policy, nowMs) };
  } catch (error) {
    if (error instanceof AuthorizationDenied) return reply(403, 'forbidden');
    if (error instanceof Unauthenticated) return reply(401, 'unauthenticated');
    return reply(503, error instanceof Unavailable ? 'verifier-unavailable' : 'verifier-error');
  }
}
