import { memoryNotice } from '@agent-works/domain/user-memory';

import { changeConsent, readConsent } from '../memory/consent.js';

import { ownMemoryRoute, parseMemoryBody } from './memory-auth.js';

import type { MemoryRouteDeps } from './memory-auth.js';
export function memoryConsentRoutes(deps: MemoryRouteDeps) {
  return {
    'GET /v1/memory/consent': ownMemoryRoute(deps, async (scope) => ({
      status: 200,
      body: {
        consent: await readConsent(deps.store, scope, deps.policy.now()),
        notice: memoryNotice,
        tenantEnabled: await deps.policy.tenantEnabled(scope.tenant),
      },
    })),
    'POST /v1/memory/consent': ownMemoryRoute(deps, async (scope, request) => ({
      status: 200,
      body: {
        consent: await changeConsent(
          deps.store,
          scope,
          parseMemoryBody(request),
          deps.policy.now(),
        ),
      },
    })),
  };
}
