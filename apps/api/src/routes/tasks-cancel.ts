import { IAP_ASSERTION_HEADER } from '@agent-works/domain';

import { Unavailable, Unauthenticated, createIapVerifier } from '../auth/iap.js';
import { headerValue } from '../http.js';
import { workflowRuntime } from '../workflow/runtime.js';

import { notImplementedRoute } from './not-implemented.js';

import type { VerifyAssertion } from '../auth/iap.js';
import type { ApiReply, Route } from '../http.js';
import type { PatternSlot } from './slot.js';
import type { LocalEngine } from '../workflow/local-engine.js';

const unauthenticated = {
  status: 401,
  body: { error: 'unauthenticated' },
} as const satisfies ApiReply;
const invalidRequest = {
  status: 400,
  body: { error: 'invalid_request' },
} as const satisfies ApiReply;
const notFound = { status: 404, body: { error: 'not_found' } } as const satisfies ApiReply;
const unavailable = { status: 503, body: { error: 'unavailable' } } as const satisfies ApiReply;

const idempotencyHeader = 'idempotency-key';

export function createCancelRoute(engine: LocalEngine, verify: VerifyAssertion): Route {
  return (request) => cancelTask(engine, verify, request);
}

export const cancelTaskRoute = createCancelRoute(workflowRuntime.engine, envVerifier());

export const tasksCancelSlot: PatternSlot = {
  id: 'tasks-cancel',
  env: 'AW_TASKS_CANCEL',
  method: 'POST',
  match: /^\/v1\/tasks\/([^/]+):cancel$/,
  kind: 'pattern',
  stub: notImplementedRoute,
  real: cancelTaskRoute,
};

async function cancelTask(
  engine: LocalEngine,
  verify: VerifyAssertion,
  request: Parameters<Route>[0],
): Promise<ApiReply> {
  const subject = await authenticate(verify, request);
  if (typeof subject !== 'string') return subject;
  const taskId = taskIdFrom(request.path);
  if (taskId === undefined) return notFound;
  const signalId = headerValue(request.headers, idempotencyHeader);
  if (signalId === undefined || signalId.length === 0) return invalidRequest;
  const result = await engine.cancel(subject, taskId, signalId);
  if (!result.ok) return notFound;
  return { status: 200, body: { taskId, status: result.status } };
}

function taskIdFrom(path: string): string | undefined {
  return path.match(tasksCancelSlot.match)?.[1];
}

async function authenticate(
  verify: VerifyAssertion,
  request: Parameters<Route>[0],
): Promise<string | ApiReply> {
  try {
    const caller = await verify(headerValue(request.headers, IAP_ASSERTION_HEADER));
    return caller.sub;
  } catch (error) {
    if (error instanceof Unauthenticated) return unauthenticated;
    if (error instanceof Unavailable) return unavailable;
    throw error;
  }
}

function envVerifier(): VerifyAssertion {
  let cached: VerifyAssertion | undefined;
  return (assertion) => {
    cached ??= verifierFromEnv();
    return cached(assertion);
  };
}

function verifierFromEnv(): VerifyAssertion {
  const jwksUrl = process.env.IAP_JWKS_URL;
  const issuer = process.env.IAP_ISSUER;
  const audience = process.env.IAP_AUDIENCE;
  if (
    jwksUrl === undefined ||
    issuer === undefined ||
    audience === undefined ||
    jwksUrl.length === 0 ||
    issuer.length === 0 ||
    audience.length === 0
  ) {
    return () => Promise.reject(new Unavailable('iap'));
  }
  return createIapVerifier({ jwksUrl, issuer, audience });
}
