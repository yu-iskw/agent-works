import { IAP_ASSERTION_HEADER } from '@agent-works/domain';

import { Unauthenticated } from '../auth/iap.js';
import { headerValue } from '../http.js';
import { KeyUnavailable } from '../ports/governance-key-provider.js';

import type { ArtifactReadContext, ArtifactStore } from './artifact-store.js';
import type { VerifyAssertion } from '../auth/iap.js';
import type { Route } from '../http.js';

export type GovernedArtifactReadDeps = {
  readonly verify: VerifyAssertion;
  readonly store: ArtifactStore;
  readonly contextFor: (subject: string) => Promise<ArtifactReadContext>;
};
export function governedArtifactReadRoute(deps: GovernedArtifactReadDeps): Route {
  return async (request) => {
    try {
      const caller = await deps.verify(headerValue(request.headers, IAP_ASSERTION_HEADER));
      const context = await deps.contextFor(caller.sub);
      if (context.subject !== caller.sub) return { status: 403, body: { error: 'forbidden' } };
      const encodedId = /^\/v1\/artifacts\/([^/]+)$/.exec(request.path)?.[1];
      if (encodedId === undefined) return { status: 404, body: { error: 'not_found' } };
      const text = await deps.store.read(decodeURIComponent(encodedId), context);
      return text === undefined
        ? { status: 404, body: { error: 'not_found' } }
        : { status: 200, body: { text } };
    } catch (error) {
      if (error instanceof Unauthenticated)
        return { status: 401, body: { error: 'unauthenticated' } };
      if (error instanceof KeyUnavailable)
        return { status: 503, body: { error: 'artifact_key_unavailable' } };
      return { status: 503, body: { error: 'artifact_unavailable' } };
    }
  };
}
