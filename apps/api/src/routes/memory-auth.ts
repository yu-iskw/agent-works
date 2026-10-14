import { IAP_ASSERTION_HEADER } from '@agent-works/domain';
import { ZodError } from 'zod';

import { Unauthenticated } from '../auth/iap.js';
import { headerValue } from '../http.js';
import { MemoryConflict, MemoryDenied } from '../ports/user-memory.js';

import type { VerifyAssertion } from '../auth/iap.js';
import type { Route } from '../http.js';
import type { MemoryPolicy, MemoryStore } from '../ports/user-memory.js';
import type { MemoryScope } from '@agent-works/domain/user-memory';
export type MemoryRouteDeps = {
  verify: VerifyAssertion;
  tenantFor: (subject: string) => Promise<string>;
  store: MemoryStore;
  policy: MemoryPolicy;
};
export function ownMemoryRoute(
  deps: MemoryRouteDeps,
  operation: (scope: MemoryScope, request: Parameters<Route>[0]) => ReturnType<Route>,
): Route {
  return async (request) => {
    try {
      const caller = await deps.verify(headerValue(request.headers, IAP_ASSERTION_HEADER));
      const tenant = await deps.tenantFor(caller.sub);
      return await operation({ tenant, owner: caller.sub, agent: 'default' }, request);
    } catch (error) {
      if (error instanceof Unauthenticated)
        return { status: 401, body: { error: 'unauthenticated' } };
      if (error instanceof ZodError || error instanceof SyntaxError)
        return { status: 400, body: { error: 'invalid_memory_command' } };
      if (error instanceof MemoryDenied) return { status: 403, body: { error: 'memory_disabled' } };
      if (error instanceof MemoryConflict)
        return { status: 409, body: { error: 'memory_conflict' } };
      return { status: 503, body: { error: 'memory_unavailable' } };
    }
  };
}
export function parseMemoryBody(request: Parameters<Route>[0]): unknown {
  if (request.body.length > 16384) throw new SyntaxError('body too large');
  return JSON.parse(request.body.toString('utf8')) as unknown;
}
