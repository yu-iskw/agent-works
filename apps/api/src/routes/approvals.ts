import {
  IAP_ASSERTION_HEADER,
  approvalApiSchema,
  approvalDecidedSchema,
} from '@agent-works/domain';

import { createRoleResolver } from '../auth/directory.js';
import { Unauthenticated, Unavailable } from '../auth/iap.js';
import { headerValue } from '../http.js';

import type { AppRole } from '../auth/directory.js';
import type { Caller, VerifyAssertion } from '../auth/iap.js';
import type { ApprovalStore, DecisionCommand } from '../broker/approvals.js';
import type { ApiReply, Route } from '../http.js';
import type { Approval, ApprovalDecide, ApprovalDecided } from '@agent-works/domain';

const csrfHeader = 'x-csrf-token';

const unauthenticated = {
  status: 401,
  body: { error: 'unauthenticated' },
} as const satisfies ApiReply;
const unavailable = { status: 503, body: { error: 'unavailable' } } as const satisfies ApiReply;
const invalidRequest = {
  status: 400,
  body: { error: 'invalid_request' },
} as const satisfies ApiReply;
const csrfMissing = { status: 403, body: { error: 'csrf_missing' } } as const satisfies ApiReply;
const forbidden = { status: 403, body: { error: 'forbidden' } } as const satisfies ApiReply;
const notFound = { status: 404, body: { error: 'not_found' } } as const satisfies ApiReply;
const selfApproval = { status: 403, body: { error: 'self_approval' } } as const satisfies ApiReply;
const staleDigest = { status: 409, body: { error: 'stale_digest' } } as const satisfies ApiReply;
const approvalRequired = {
  status: 422,
  body: { error: 'approval_required' },
} as const satisfies ApiReply;

export const approvalsDecideMatch = /^\/v1\/approvals\/([^/]+):decide$/;

export type ApprovalsDeps = {
  readonly store: ApprovalStore;
  readonly verify: VerifyAssertion;
  readonly rolesFor?: (sub: string) => Promise<readonly AppRole[]>;
};

type ApiRequest = Parameters<Route>[0];

type Gate =
  | { readonly kind: 'not_found' }
  | { readonly kind: 'self_approval' }
  | { readonly kind: 'stale_digest' }
  | { readonly kind: 'replay'; readonly decided: ApprovalDecided }
  | { readonly kind: 'bind'; readonly id: string; readonly command: DecisionCommand };

type Facts = {
  readonly body: ApprovalDecide;
  readonly id: string;
  readonly approval: Approval | undefined;
  readonly callerSub: string;
};

export function createApprovalsRoute(deps: ApprovalsDeps): Route {
  const resolved = { ...deps, rolesFor: deps.rolesFor ?? envRoles() };
  return (request) => decide(resolved, request);
}

async function decide(deps: Required<ApprovalsDeps>, request: ApiRequest): Promise<ApiReply> {
  const subject = await authenticate(deps.verify, request);
  if (typeof subject !== 'string') return subject;
  if (!hasCsrf(request.headers)) return csrfMissing;
  const body = parseDecide(request.body);
  const id = approvalId(request.path);
  if (body === undefined || id === undefined) return invalidRequest;
  const roles = await deps.rolesFor(subject);
  if (!roles.includes('Reviewer')) return forbidden;
  const approval = await deps.store.read(id);
  return applyGate(deps.store, decideGate({ body, id, approval, callerSub: subject }));
}

function decideGate(facts: Facts): Gate {
  if (facts.approval === undefined) return { kind: 'not_found' };
  if (facts.approval.payloadSha256 !== facts.body.expectedPayloadSha256) {
    return { kind: 'stale_digest' };
  }
  const settled = decidedState(facts.approval);
  if (settled !== undefined) return { kind: 'replay', decided: settled };
  if (facts.body.decision === 'approve' && facts.callerSub === facts.approval.requestedBySub) {
    return { kind: 'self_approval' };
  }
  return {
    kind: 'bind',
    id: facts.id,
    command: {
      actorSub: facts.callerSub,
      decision: facts.body.decision,
      expectedPayloadSha256: facts.body.expectedPayloadSha256,
    },
  };
}

function decidedState(approval: Approval): ApprovalDecided | undefined {
  if (approval.state !== 'approved' && approval.state !== 'rejected') return undefined;
  return approvalDecidedSchema.parse({
    id: approval.id,
    state: approval.state,
    executionsUsed: approval.executionsUsed,
  });
}

async function applyGate(store: ApprovalStore, gate: Gate): Promise<ApiReply> {
  switch (gate.kind) {
    case 'not_found':
      return notFound;
    case 'self_approval':
      return selfApproval;
    case 'stale_digest':
      return staleDigest;
    case 'replay':
      return decidedReply(gate.decided);
    case 'bind':
      return bindReply(store, gate.id, gate.command);
    default: {
      const unreachable: never = gate;
      return unreachable;
    }
  }
}

async function bindReply(
  store: ApprovalStore,
  id: string,
  command: DecisionCommand,
): Promise<ApiReply> {
  const bound = await store.bind(id, command);
  if (!bound.ok) return approvalRequired;
  return decidedReply(bound.decided);
}

function decidedReply(decided: ApprovalDecided): ApiReply {
  return { status: 200, body: { kind: 'decided', ...decided } };
}

function hasCsrf(headers: ApiRequest['headers']): boolean {
  const token = headerValue(headers, csrfHeader);
  return token !== undefined && token.length > 0;
}

function parseDecide(body: Buffer): ApprovalDecide | undefined {
  const parsed = approvalApiSchema.safeParse(parseJson(body));
  if (!parsed.success || parsed.data.kind !== 'decide') return undefined;
  return {
    decision: parsed.data.decision,
    expectedPayloadSha256: parsed.data.expectedPayloadSha256,
  };
}

function parseJson(body: Buffer): unknown {
  if (body.length === 0) return undefined;
  try {
    return JSON.parse(body.toString('utf8')) as unknown;
  } catch {
    return undefined;
  }
}

function approvalId(path: string): string | undefined {
  return approvalsDecideMatch.exec(path)?.[1];
}

async function authenticate(
  verify: VerifyAssertion,
  request: ApiRequest,
): Promise<string | ApiReply> {
  try {
    const verified: Caller = await verify(headerValue(request.headers, IAP_ASSERTION_HEADER));
    return verified.sub;
  } catch (error) {
    if (error instanceof Unauthenticated) return unauthenticated;
    if (error instanceof Unavailable) return unavailable;
    throw error;
  }
}

function envRoles(): (sub: string) => Promise<readonly AppRole[]> {
  let resolver: ((sub: string) => Promise<readonly AppRole[]>) | undefined;
  return (sub) => {
    const baseUrl = process.env.DIRECTORY_URL;
    if (baseUrl === undefined || baseUrl.length === 0) return Promise.resolve([]);
    resolver ??= createRoleResolver({ baseUrl });
    return resolver(sub);
  };
}
