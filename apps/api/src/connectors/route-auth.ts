import { IAP_ASSERTION_HEADER } from '@agent-works/domain';
import { ZodError } from 'zod';

import { Unauthenticated } from '../auth/iap.js';
import { headerValue } from '../http.js';

import { ConnectorError } from './errors.js';

import type { VerifyAssertion } from '../auth/iap.js';
import type { Route } from '../http.js';
export function callerRoute(
  verify: VerifyAssertion,
  operation: (subject: string, request: Parameters<Route>[0]) => ReturnType<Route>,
): Route {
  return async (request) => {
    try {
      const caller = await verify(headerValue(request.headers, IAP_ASSERTION_HEADER));
      if (!caller.sub) throw new Unauthenticated('bad_claims');
      return await operation(caller.sub, request);
    } catch (error) {
      if (error instanceof Unauthenticated)
        return { status: 401, body: { error: 'AUTH_REQUIRED' } };
      if (error instanceof ZodError || error instanceof SyntaxError)
        return { status: 400, body: { error: 'INVALID_REQUEST' } };
      if (error instanceof ConnectorError)
        return { status: error.status, body: { error: error.code } };
      return { status: 503, body: { error: 'UPSTREAM_UNAVAILABLE' } };
    }
  };
}
export function workspaceBody(request: Parameters<Route>[0]): unknown {
  if (request.body.byteLength > 150_000) throw new ConnectorError('INVALID_REQUEST', 400);
  return JSON.parse(request.body.toString('utf8')) as unknown;
}
