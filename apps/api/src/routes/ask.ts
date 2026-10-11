import {
  canonicalPayloadSha256,
  IAP_ASSERTION_HEADER,
  askRequestSchema,
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
    const result = await deps.audit.run(request.requestId, async () => {
      const outcome = await decide(deps, caller, request);
      return {
        event: auditEventFor(caller, request, outcome, deps.now(), requestDigestSha256),
        reply: replyFor(outcome, request.requestId),
      };
    });
    switch (result.kind) {
      case 'done':
        return result.reply;
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
    const cited = new Set(output.citedSourceIds);
    return {
      kind: 'answered',
      answer: output.answer,
      sources: sources.filter((source) => cited.has(source.id)),
    };
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
