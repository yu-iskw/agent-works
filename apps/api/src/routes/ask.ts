import {
  canonicalPayloadSha256,
  IAP_ASSERTION_HEADER,
  askRequestSchema,
  auditEventSchema,
} from '@agent-works/domain';

import { RunnerError } from '../agent/runner-port.js';
import { Unauthenticated, Unavailable } from '../auth/iap.js';
import { headerValue } from '../http.js';
import { RetrievalError } from '../retrieval/drive-port.js';

import type { AgentRunner } from '../agent/runner-port.js';
import type { AppendResult, AuditLog } from '../audit/write.js';
import type { Caller, VerifyAssertion } from '../auth/iap.js';
import type { ApiReply, Route } from '../http.js';
import type { Drive, SourceDocument } from '../retrieval/drive-port.js';
import type { AuditEvent, AskRequest } from '@agent-works/domain';

export type AskDeps = {
  readonly verify: VerifyAssertion;
  readonly drive: Drive;
  readonly runner: AgentRunner;
  readonly audit: AuditLog;
  readonly now: () => Date;
};

type AskOutcome =
  | {
      readonly kind: 'answered';
      readonly answer: string;
      readonly sources: readonly SourceDocument[];
    }
  | { readonly kind: 'no_sources' }
  | { readonly kind: 'retrieval_failed' }
  | { readonly kind: 'runner_failed' };

const noSourcesAnswer = 'I could not find a source for that.';

type AskSettlement =
  | { readonly ok: true; readonly reply: ApiReply }
  | { readonly ok: false; readonly error: unknown };

type AskClaim = {
  readonly callerSub: string;
  readonly question: string;
  readonly done: Promise<AskSettlement>;
};

export function createAskRoute(deps: AskDeps): Route {
  const claims = new Map<string, AskClaim>();
  return async (request) => {
    const authenticated = await authenticate(
      deps.verify,
      headerValue(request.headers, IAP_ASSERTION_HEADER),
    );
    if (authenticated.ok === false) return authenticated.reply;
    const parsed = askRequestSchema.safeParse(parseJson(request.body));
    if (!parsed.success) return { status: 400, body: { error: 'invalid_request' } };
    return answer(claims, deps, authenticated.caller, parsed.data);
  };
}

async function answer(
  claims: Map<string, AskClaim>,
  deps: AskDeps,
  caller: Caller,
  request: AskRequest,
): Promise<ApiReply> {
  const existing = claims.get(request.requestId);
  if (existing !== undefined) return replay(existing, caller, request);

  let publish!: (settlement: AskSettlement) => void;
  const done = new Promise<AskSettlement>((resolve) => {
    publish = resolve;
  });
  claims.set(request.requestId, { callerSub: caller.sub, question: request.question, done });
  try {
    const reply = await record(deps, caller, request, await decide(deps, caller, request));
    publish({ ok: true, reply });
    if (reply.status !== 200) claims.delete(request.requestId);
    return reply;
  } catch (error) {
    claims.delete(request.requestId);
    publish({ ok: false, error });
    throw error;
  }
}

async function replay(claim: AskClaim, caller: Caller, request: AskRequest): Promise<ApiReply> {
  if (claim.callerSub !== caller.sub || claim.question !== request.question) {
    return { status: 409, body: { error: 'conflict' } };
  }
  const settlement = await claim.done;
  if (!settlement.ok) throw settlement.error;
  return settlement.reply;
}

type AuthResult =
  | { readonly ok: true; readonly caller: Caller }
  | { readonly ok: false; readonly reply: ApiReply };

async function authenticate(
  verify: VerifyAssertion,
  assertion: string | undefined,
): Promise<AuthResult> {
  try {
    return { ok: true, caller: await verify(assertion) };
  } catch (error) {
    if (error instanceof Unauthenticated) {
      return { ok: false, reply: { status: 401, body: { error: 'unauthenticated' } } };
    }
    if (error instanceof Unavailable) {
      return { ok: false, reply: { status: 503, body: { error: 'unavailable' } } };
    }
    throw error;
  }
}

async function decide(deps: AskDeps, caller: Caller, request: AskRequest): Promise<AskOutcome> {
  let sources: readonly SourceDocument[];
  try {
    sources = await deps.drive.retrieve(caller, request.question);
  } catch (error) {
    if (error instanceof RetrievalError) return { kind: 'retrieval_failed' };
    throw error;
  }
  if (sources.length === 0) return { kind: 'no_sources' };
  try {
    const output = await deps.runner.run({ question: request.question, sources });
    return { kind: 'answered', answer: output.answer, sources };
  } catch (error) {
    if (error instanceof RunnerError) return { kind: 'runner_failed' };
    throw error;
  }
}

async function record(
  deps: AskDeps,
  caller: Caller,
  request: AskRequest,
  outcome: AskOutcome,
): Promise<ApiReply> {
  try {
    const appended = await deps.audit.append(auditEventFor(caller, request, outcome, deps.now()));
    return replyAfterAppend(appended, outcome, request.requestId);
  } catch {
    return { status: 503, body: { error: 'audit_failed' } };
  }
}

function replyAfterAppend(
  appended: AppendResult,
  outcome: AskOutcome,
  requestId: string,
): ApiReply {
  switch (appended.kind) {
    case 'recorded':
    case 'replay':
      return replyFor(outcome, requestId);
    case 'conflict':
      return { status: 409, body: { error: 'conflict' } };
    default: {
      const unexpected: never = appended;
      return unexpected;
    }
  }
}

function replyFor(outcome: AskOutcome, requestId: string): ApiReply {
  switch (outcome.kind) {
    case 'answered':
      return {
        status: 200,
        body: {
          requestId,
          answer: outcome.answer,
          citations: outcome.sources.map((source) => ({
            sourceObjectId: source.id,
            title: source.title,
            sourceUri: source.uri,
          })),
        },
      };
    case 'no_sources':
      return { status: 200, body: { requestId, answer: noSourcesAnswer, citations: [] } };
    case 'retrieval_failed':
      return { status: 502, body: { error: 'retrieval_failed' } };
    case 'runner_failed':
      return { status: 502, body: { error: 'runner_failed' } };
    default: {
      const unexpected: never = outcome;
      return unexpected;
    }
  }
}

function auditEventFor(
  caller: Caller,
  request: AskRequest,
  outcome: AskOutcome,
  now: Date,
): AuditEvent {
  return auditEventSchema.parse({
    eventId: request.requestId,
    eventType: 'ask',
    schemaVersion: '1',
    occurredAt: now.toISOString(),
    taskId: request.requestId,
    stepId: 'ask',
    traceId: request.requestId.replaceAll('-', ''),
    initiatorSubject: caller.sub,
    agentPrincipal: 'agent:scripted-runner',
    tool: 'drive.list',
    policyDecisionId: null,
    approvalId: null,
    requestDigestSha256: canonicalPayloadSha256({ question: request.question }),
    outcome: outcome.kind,
    externalObjectRef: null,
    prevDigest: null,
  });
}

function parseJson(body: Buffer): unknown {
  if (body.length === 0) return undefined;
  try {
    return JSON.parse(body.toString('utf8')) as unknown;
  } catch {
    return undefined;
  }
}
