import {
  askRequestSchema,
  auditEventSchema,
  canonicalPayloadSha256,
  IAP_ASSERTION_HEADER,
  runnerLimitsSchema,
} from '@agent-works/domain';
import { decide as decidePolicy } from '@agent-works/policy';

import { createAdkRunner } from '../agent/adk-runner.js';
import { RunnerError } from '../agent/runner-port.js';
import { AuditWriteError } from '../audit/write.js';
import { Unauthenticated, Unavailable } from '../auth/iap.js';
import { readRunnerKind } from '../config.js';
import { headerValue } from '../http.js';
import { RetrievalError } from '../retrieval/drive-port.js';
import { ContextMismatch, askPolicy, contextFor } from '../retrieval/search.js';

import type { AgentRunner } from '../agent/runner-port.js';
import type { AuditLog } from '../audit/write.js';
import type { Caller, VerifyAssertion } from '../auth/iap.js';
import type { ApiReply, Route } from '../http.js';
import type { LedgerPort } from '../ports/ledger-port.js';
import type { SearchPort } from '../ports/search-port.js';
import type { Drive, SourceDocument } from '../retrieval/drive-port.js';
import type { GroupSnapshot } from '../retrieval/search.js';
import type { AuditEvent, AskRequest, PolicyClause, TaskSubmit } from '@agent-works/domain';

type AskWire = {
  readonly search: SearchPort;
  readonly ledger: LedgerPort;
  readonly groups: (caller: Caller) => Promise<GroupSnapshot>;
};

export type AskDeps = {
  readonly verify: VerifyAssertion;
  readonly drive: Drive;
  readonly runner: AgentRunner;
  readonly audit: AuditLog;
  readonly now: () => Date;
  readonly wire?: AskWire;
};

const askAllowFacts: { readonly [Clause in PolicyClause]: true } = {
  authenticated_actor: true,
  active_org_membership: true,
  permitted_app_role: true,
  approved_agent_and_skill_version: true,
  agent_has_tool_capability: true,
  user_or_service_has_resource_authority: true,
  source_system_allows_operation: true,
  data_classification_policy_allows: true,
  valid_approval_if_required: true,
  within_time_and_budget_bounds: true,
};

const searchTool = 'drive.search@1';

const askLimits = runnerLimitsSchema.parse({
  maxSteps: 4,
  maxToolCalls: 4,
  maxCostUsd: 1,
  maxElapsedMs: 30_000,
  maxBytesRetrieved: 1_000_000,
  maxGeneratedOutputs: 1,
  maxModelRetries: 1,
  maxSubagents: 0,
  maxParallelToolCalls: 1,
});

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
    const result = await deps.audit.run(request.requestId, () =>
      deps.wire === undefined
        ? recordUnwired(deps, caller, request, requestDigestSha256)
        : runWired(deps, deps.wire, caller, request, requestDigestSha256),
    );
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

async function retrieveAndRun(
  deps: AskDeps,
  caller: Caller,
  request: AskRequest,
): Promise<AskOutcome> {
  let sources: readonly SourceDocument[];
  try {
    sources = await deps.drive.retrieve(caller, request.question);
  } catch (error) {
    if (error instanceof RetrievalError) return { kind: 'retrieval_failed' };
    throw error;
  }
  return citeAnswer(deps, request, sources);
}

function replyFor(outcome: AskOutcome, requestId: string, retrievedAt: string): ApiReply {
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
            retrievedAt,
            excerpt: source.text,
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

function auditEvent(input: {
  readonly caller: Caller;
  readonly request: AskRequest;
  readonly outcome: string;
  readonly now: Date;
  readonly requestDigestSha256: string;
  readonly taskId: string;
  readonly tool: string | null;
  readonly policyDecisionId: string | null;
}): AuditEvent {
  return auditEventSchema.parse({
    eventId: input.request.requestId,
    eventType: 'ask',
    schemaVersion: '1',
    occurredAt: input.now.toISOString(),
    taskId: input.taskId,
    stepId: 'ask',
    traceId: input.request.requestId.replaceAll('-', ''),
    initiatorSubject: input.caller.sub,
    agentPrincipal: agentName(),
    tool: input.tool,
    policyDecisionId: input.policyDecisionId,
    approvalId: null,
    requestDigestSha256: input.requestDigestSha256,
    outcome: input.outcome,
    externalObjectRef: null,
    prevDigest: null,
  });
}

async function recordUnwired(
  deps: AskDeps,
  caller: Caller,
  request: AskRequest,
  requestDigestSha256: string,
): Promise<{ readonly event: AuditEvent; readonly reply: ApiReply }> {
  const outcome = await retrieveAndRun(deps, caller, request);
  const now = deps.now();
  return {
    event: auditEvent({
      caller,
      request,
      outcome: outcome.kind,
      now,
      requestDigestSha256,
      taskId: request.requestId,
      tool: 'drive.list',
      policyDecisionId: null,
    }),
    reply: replyFor(outcome, request.requestId, now.toISOString()),
  };
}

async function runWired(
  deps: AskDeps,
  wire: AskWire,
  caller: Caller,
  request: AskRequest,
  requestDigestSha256: string,
): Promise<{ readonly event: AuditEvent; readonly reply: ApiReply }> {
  const decision = decidePolicy({ facts: askAllowFacts });
  if (decision.effect === 'deny') {
    const now = deps.now();
    return {
      event: auditEvent({
        caller,
        request,
        outcome: 'denied',
        now,
        requestDigestSha256,
        taskId: request.requestId,
        tool: null,
        policyDecisionId: decision.decisionId,
      }),
      reply: { status: 403, body: { error: 'denied' } },
    };
  }
  const outcome = await searchAndRun(deps, wire, caller, request);
  const accepted = await wire.ledger.submit(
    caller.sub,
    askTask(request.question),
    request.requestId,
  );
  const now = deps.now();
  const event = auditEvent({
    caller,
    request,
    outcome: outcome.kind,
    now,
    requestDigestSha256,
    taskId: accepted.taskId,
    tool: searchTool,
    policyDecisionId: decision.decisionId,
  });
  await wire.ledger.append({ destination: 'audit', event });
  return { event, reply: replyFor(outcome, request.requestId, now.toISOString()) };
}

async function searchAndRun(
  deps: AskDeps,
  wire: AskWire,
  caller: Caller,
  request: AskRequest,
): Promise<AskOutcome> {
  let sources: readonly SourceDocument[];
  try {
    const context = contextFor(caller, await wire.groups(caller), askPolicy);
    sources = (await wire.search.search(context, request.question)).map((citation) => ({
      id: citation.sourceObjectId,
      title: citation.title,
      text: citation.excerpt,
      uri: citation.sourceUri,
    }));
  } catch (error) {
    if (error instanceof ContextMismatch || error instanceof RetrievalError) {
      return { kind: 'retrieval_failed' };
    }
    throw error;
  }
  return citeAnswer(deps, request, sources);
}

async function citeAnswer(
  deps: AskDeps,
  request: AskRequest,
  sources: readonly SourceDocument[],
): Promise<AskOutcome> {
  if (sources.length === 0) return { kind: 'no_sources' };
  try {
    const output = await resolveRunner(deps).run({ question: request.question, sources });
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

function askTask(question: string): TaskSubmit {
  return {
    objective: question,
    skillId: 'ask',
    sourceAllowlist: ['drive'],
    requestedOutputs: ['answer'],
    executionPolicy: { mode: 'interactive', budgetUsd: 0.1, deadlineSeconds: 30 },
  };
}

function resolveRunner(deps: AskDeps): AgentRunner {
  if (readRunnerKind(process.env) !== 'adk') return deps.runner;
  const baseUrl = process.env.LLM_URL;
  if (baseUrl === undefined || baseUrl.trim().length === 0) return deps.runner;
  return createAdkRunner({ baseUrl, limits: askLimits });
}

function agentName(): string {
  return readRunnerKind(process.env) === 'adk' ? 'agent:adk-runner' : 'agent:scripted-runner';
}

function parseJson(body: Buffer): unknown {
  if (body.length === 0) return undefined;
  try {
    return JSON.parse(body.toString('utf8')) as unknown;
  } catch {
    return undefined;
  }
}
