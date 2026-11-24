import { randomUUID } from 'node:crypto';

import { RunnerError } from '@agent-works/agent-runtime/port';
import { auditEventSchema, canonicalPayloadSha256 } from '@agent-works/domain';

import { rolesAt } from '../../auth/directory.js';
import { LedgerConflict } from '../../ports/ledger-port.js';
import { RetrievalError } from '../../retrieval/drive-port.js';
import { ContextMismatch, askPolicy, contextFor } from '../../retrieval/search.js';

import type { AskAudit, AskClock, AskPolicy, AskRetrieval, AskRunner, AskWire } from './ports.js';
import type { Caller } from '../../auth/iap.js';
import type { SourceDocument } from '../../retrieval/drive-port.js';
import type {
  AskRequest,
  AuditEvent,
  Citation,
  SearchContext,
  TaskSubmit,
} from '@agent-works/domain';

export type AskUseCaseDeps = AskRunner & {
  readonly retrieval: AskRetrieval;
  readonly audit: AskAudit;
  readonly policy: AskPolicy;
  readonly clock: AskClock;
  /** Authorized path; without it the ask retrieves through `retrieval` and skips policy. */
  readonly wire?: AskWire;
};

export type AskResult =
  | { readonly kind: 'answered'; readonly answer: string; readonly citations: readonly Citation[] }
  | { readonly kind: 'no_sources' }
  | { readonly kind: 'denied' }
  | { readonly kind: 'retrieval_failed' }
  | { readonly kind: 'runner_failed' }
  | { readonly kind: 'conflict' };

type AnswerSource = SourceDocument & { readonly retrievedAt?: string; readonly excerpt?: string };

type AskOutcome =
  | {
      readonly kind: 'answered';
      readonly answer: string;
      readonly sources: readonly AnswerSource[];
    }
  | { readonly kind: 'no_sources' }
  | { readonly kind: 'retrieval_failed' }
  | { readonly kind: 'runner_failed' };

type Produced = { readonly event: AuditEvent; readonly reply: AskResult };

const searchTool = 'drive.search@1';

/**
 * Answers one ask for a verified caller, exactly once per request id. The audit log reserves the
 * id; a retry after a lost acknowledgement must match the persisted caller and question digest.
 * Throws the audit log's own failure and any error the runner raises other than `RunnerError`.
 */
export async function ask(
  deps: AskUseCaseDeps,
  caller: Caller,
  request: AskRequest,
): Promise<AskResult> {
  const requestDigestSha256 = canonicalPayloadSha256({ question: request.question });
  try {
    const result = await deps.audit.run(request.requestId, () =>
      deps.wire === undefined
        ? recordUnwired(deps, caller, request, requestDigestSha256)
        : runWired(deps, deps.wire, caller, request, requestDigestSha256),
    );
    return result.kind === 'done' ? result.reply : { kind: 'conflict' };
  } catch (error) {
    if (error instanceof LedgerConflict) return { kind: 'conflict' };
    throw error;
  }
}

async function recordUnwired(
  deps: AskUseCaseDeps,
  caller: Caller,
  request: AskRequest,
  requestDigestSha256: string,
): Promise<Produced> {
  const outcome = await retrieveAndRun(deps, caller, request);
  const now = deps.clock();
  return {
    event: auditEvent({
      agentPrincipal: deps.agentPrincipal,
      caller,
      request,
      outcome: outcome.kind,
      now,
      requestDigestSha256,
      taskId: request.requestId,
      tool: 'drive.list',
      policyDecisionId: null,
    }),
    reply: resultFor(outcome, now.toISOString()),
  };
}

async function runWired(
  deps: AskUseCaseDeps,
  wire: AskWire,
  caller: Caller,
  request: AskRequest,
  requestDigestSha256: string,
): Promise<Produced> {
  const persisted = await wire.ledger.readOutbox(request.requestId);
  if (
    persisted !== undefined &&
    (persisted.destination !== 'audit' ||
      persisted.event.eventType !== 'ask' ||
      persisted.event.initiatorSubject !== caller.sub ||
      persisted.event.requestDigestSha256 !== requestDigestSha256)
  ) {
    throw new LedgerConflict('outbox event changed');
  }
  const eventId = persisted === undefined ? request.requestId : randomUUID();
  const authorization = await authorize(wire, caller, deps.clock());
  const decision = deps.policy(authorization.input);
  if (decision.effect === 'deny') {
    const now = deps.clock();
    return {
      event: auditEvent({
        eventId,
        agentPrincipal: deps.agentPrincipal,
        caller,
        request,
        outcome: 'denied',
        now,
        requestDigestSha256,
        taskId: persisted?.event.taskId ?? request.requestId,
        tool: null,
        policyDecisionId: decision.decisionId,
      }),
      reply: { kind: 'denied' },
    };
  }
  const outcome = await searchAndRun(deps, wire, authorization.context, request);
  const accepted = await wire.ledger.submit(
    caller.sub,
    askTask(request.question),
    request.requestId,
  );
  const now = deps.clock();
  if (persisted !== undefined && persisted.event.taskId !== accepted.taskId) {
    throw new LedgerConflict('outbox event changed');
  }
  const event = auditEvent({
    eventId,
    agentPrincipal: deps.agentPrincipal,
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
  return { event, reply: resultFor(outcome, now.toISOString()) };
}

async function authorize(wire: AskWire, caller: Caller, now: Date) {
  try {
    const snapshot = await wire.groups(caller);
    const roles = rolesAt(snapshot, now.getTime());
    const context = contextFor(caller, snapshot, askPolicy);
    const input = await wire.policyInput?.(caller, context);
    return {
      context,
      input: {
        facts: {
          ...input?.facts,
          authenticated_actor: caller.sub.length > 0,
          active_org_membership: roles.length > 0,
          permitted_app_role: roles.includes('Employee'),
        },
      },
    };
  } catch {
    return { context: undefined, input: { facts: { authenticated_actor: caller.sub.length > 0 } } };
  }
}

async function retrieveAndRun(
  deps: AskUseCaseDeps,
  caller: Caller,
  request: AskRequest,
): Promise<AskOutcome> {
  let sources: readonly AnswerSource[];
  try {
    sources = await deps.retrieval.retrieve(caller, request.question);
  } catch (error) {
    if (error instanceof RetrievalError) return { kind: 'retrieval_failed' };
    throw error;
  }
  return citeAnswer(deps, request, sources);
}

async function searchAndRun(
  deps: AskUseCaseDeps,
  wire: AskWire,
  context: SearchContext | undefined,
  request: AskRequest,
): Promise<AskOutcome> {
  if (context === undefined) return { kind: 'retrieval_failed' };
  let sources: readonly AnswerSource[];
  try {
    sources = (await wire.search.search(context, request.question)).map((citation) => ({
      id: citation.sourceObjectId,
      title: citation.title,
      text: citation.text,
      excerpt: citation.excerpt,
      uri: citation.sourceUri,
      retrievedAt: citation.retrievedAt,
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
  deps: AskUseCaseDeps,
  request: AskRequest,
  sources: readonly AnswerSource[],
): Promise<AskOutcome> {
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

function resultFor(outcome: AskOutcome, retrievedAt: string): AskResult {
  if (outcome.kind !== 'answered') return outcome;
  return {
    kind: 'answered',
    answer: outcome.answer,
    citations: outcome.sources.map((source) => ({
      sourceObjectId: source.id,
      title: source.title,
      sourceUri: source.uri,
      retrievedAt: source.retrievedAt ?? retrievedAt,
      excerpt: source.excerpt ?? source.text,
    })),
  };
}

function auditEvent(input: {
  readonly eventId?: string;
  readonly agentPrincipal: string;
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
    eventId: input.eventId ?? input.request.requestId,
    eventType: 'ask',
    schemaVersion: '1',
    occurredAt: input.now.toISOString(),
    taskId: input.taskId,
    stepId: 'ask',
    traceId: input.request.requestId.replaceAll('-', ''),
    initiatorSubject: input.caller.sub,
    agentPrincipal: input.agentPrincipal,
    tool: input.tool,
    policyDecisionId: input.policyDecisionId,
    approvalId: null,
    requestDigestSha256: input.requestDigestSha256,
    outcome: input.outcome,
    externalObjectRef: null,
    prevDigest: null,
  });
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
