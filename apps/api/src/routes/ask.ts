import {
  canonicalPayloadSha256,
  IAP_ASSERTION_HEADER,
  askRequestSchema,
  askResponseSchema,
  auditEventSchema,
} from '@agent-works/domain';

import { RunnerError } from '../agent/runner-port.js';
import { AuditWriteError } from '../audit/write.js';
import { Unauthenticated, Unavailable } from '../auth/iap.js';
import { headerValue } from '../http.js';
import { RetrievalError } from '../retrieval/drive-port.js';

import type { AgentRunner } from '../agent/runner-port.js';
import type { AuditLog } from '../audit/write.js';
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

export function createAskRoute(deps: AskDeps): Route {
  return async (request) => {
    const authenticated = await authenticate(
      deps.verify,
      headerValue(request.headers, IAP_ASSERTION_HEADER),
    );
    if (authenticated.ok === false) return authenticated.reply;
    const parsed = askRequestSchema.safeParse(parseJson(request.body));
    if (!parsed.success) return { status: 400, body: { error: 'invalid_request' } };
    return answer(deps, authenticated.caller, parsed.data);
  };
}

async function answer(deps: AskDeps, caller: Caller, request: AskRequest): Promise<ApiReply> {
  const requestDigestSha256 = canonicalPayloadSha256({ question: request.question });
  try {
    const attempt: { executed: boolean } = { executed: false };
    const result = await deps.audit.run(
      { eventId: request.requestId, initiatorSubject: caller.sub, requestDigestSha256 },
      async () => {
        attempt.executed = true;
        const outcome = await decide(deps, caller, request);
        return {
          event: auditEventFor(caller, request, outcome, deps.now(), requestDigestSha256),
          reply: replyFor(outcome, request.requestId),
        };
      },
    );
    switch (result.kind) {
      case 'done':
        if (attempt.executed) return result.reply;
        if (await citationsStillVisible(deps, caller, request, result.reply)) return result.reply;
        return { status: 502, body: { error: 'retrieval_failed' } };
      case 'conflict':
        return { status: 409, body: { error: 'conflict' } };
      default: {
        const unexpected: never = result;
        return unexpected;
      }
    }
  } catch (error) {
    if (error instanceof AuditWriteError) return { status: 503, body: { error: 'audit_failed' } };
    throw error;
  }
}

type AuthResult =
  { readonly ok: true; readonly caller: Caller } | { readonly ok: false; readonly reply: ApiReply };

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

async function citationsStillVisible(
  deps: AskDeps,
  caller: Caller,
  request: AskRequest,
  reply: ApiReply,
): Promise<boolean> {
  const cited = citedSourceIds(reply);
  if (cited === undefined) return false;
  if (cited.length === 0) return true;
  try {
    const sources = await deps.drive.retrieve(caller, request.question);
    const visible = new Set(sources.map((source) => source.id));
    return cited.every((id) => visible.has(id));
  } catch (error) {
    if (error instanceof RetrievalError) return false;
    throw error;
  }
}

function citedSourceIds(reply: ApiReply): readonly string[] | undefined {
  if (reply.status !== 200) return undefined;
  const parsed = askResponseSchema.safeParse(reply.body);
  if (!parsed.success) return undefined;
  return parsed.data.citations.map((citation) => citation.sourceObjectId);
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
  requestDigestSha256: string,
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
    requestDigestSha256,
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
