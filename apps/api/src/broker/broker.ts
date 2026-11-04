import {
  NonCanonicalPayload,
  canonicalPayloadSha256,
  outboxEventSchema,
  ticketCreateManifest,
} from '@agent-works/domain';

import { beforeToolCall } from '../suspension/runtime.js';

import { approvalStanding } from './approvals.js';
import { resolveAuthority } from './authority.js';

import type { ApprovalStore, BindResult, ClaimOutcome, DecisionCommand } from './approvals.js';
import type { AuthorityRequest, AuthorityResolver, AuthorityVerdict } from './authority.js';
import type { LedgerPort } from '../ports/ledger-port.js';
import type { Approval, PolicyDecision } from '@agent-works/domain';
import type { PolicyFacts } from '@agent-works/policy';

export const TICKET_TOOL = `${ticketCreateManifest.metadata.name}@${ticketCreateManifest.metadata.version}`;

export type ExecuteInput = {
  readonly id: string;
  readonly taskId: string;
  readonly stepId: string;
  readonly toolRef: string;
  readonly idempotencyKey: string;
  readonly targetResource: string;
  readonly payload: unknown;
  readonly approvalId: string;
  /** A claim. It must equal the server-resolved subject, else the call is denied. */
  readonly actorSub: string;
  readonly traceId: string;
  /** A claim. The server-resolved facts replace it. */
  readonly facts: PolicyFacts;
  readonly signal?: AbortSignal;
};

type BrokerCode =
  | 'APPROVAL_REQUIRED'
  | 'APPROVAL_EXPIRED'
  | 'POLICY_DENIED'
  | 'AUTHORITY_DENIED'
  | 'AUTHORITY_UNAVAILABLE'
  | 'DUPLICATE_CALL'
  | 'NON_CANONICAL_PAYLOAD';

type DeniedResult = { readonly ok: false; readonly status: number; readonly code: BrokerCode };

type BrokerResult =
  { readonly ok: true; readonly receipt: string; readonly replay: boolean } | DeniedResult;

type TicketBody = {
  readonly summary: string;
  readonly project: string;
};

export type Broker = {
  bindApproval(id: string, command: DecisionCommand): Promise<BindResult>;
  execute(input: ExecuteInput): Promise<BrokerResult>;
};

type PayloadHash =
  | { readonly ok: true; readonly digest: string }
  | { readonly ok: false; readonly status: number; readonly code: BrokerCode };

export type BrokerDeps = {
  readonly beforeToolCall?: typeof beforeToolCall;
  readonly store: ApprovalStore;
  readonly decide: (input: { readonly facts: PolicyFacts }) => PolicyDecision;
  readonly ledger: LedgerPort;
  readonly postTicket: (
    payload: TicketBody,
    idempotencyKey: string,
    signal?: AbortSignal,
  ) => Promise<string>;
  readonly approverAuthorized: (sub: string) => boolean;
  /**
   * Server-side authority resolution. Actor and policy facts come from it, authority is checked
   * before the claim and again right before the provider call, and any failure to resolve denies.
   */
  readonly authorize: AuthorityResolver;
  readonly now: () => Date;
};

export function createBroker(deps: BrokerDeps): Broker {
  const activeCalls = new Set<string>();
  const activeKeys = new Set<string>();
  const gate = createGate(deps.authorize);
  return {
    bindApproval(id, command) {
      if (!deps.approverAuthorized(command.actorSub)) {
        return Promise.resolve({ ok: false, status: 422, code: 'APPROVAL_REQUIRED' });
      }
      return deps.store.bind(id, command);
    },
    async execute(input) {
      if (activeCalls.has(input.id) || activeKeys.has(input.idempotencyKey)) {
        return denial('DUPLICATE_CALL', 409);
      }
      activeCalls.add(input.id);
      activeKeys.add(input.idempotencyKey);
      try {
        return await execute(deps, gate, input);
      } finally {
        activeCalls.delete(input.id);
        activeKeys.delete(input.idempotencyKey);
      }
    },
  };
}

type Granted = Extract<AuthorityVerdict, { ok: true }>;

/** Authority resolution and the bindings it imposes on approvals and resumes, built once per broker. */
type AuthorityGate = {
  resolve(input: ExecuteInput, at: Date): Promise<AuthorityVerdict>;
  requesterMatches(approval: Approval, subject: string): boolean;
  resumerMatches(claim: ClaimOutcome, subject: string): boolean;
};

function createGate(authorize: AuthorityResolver): AuthorityGate {
  return {
    resolve: (input, at) => resolveAuthority(authorize, authorityRequest(input), at),
    requesterMatches: (approval, subject) => approval.requestedBySub === subject,
    resumerMatches: (claim, subject) => claim.kind !== 'resume' || claim.actorSub === subject,
  };
}

async function execute(
  deps: BrokerDeps,
  gate: AuthorityGate,
  input: ExecuteInput,
): Promise<BrokerResult> {
  const hashed = hashPayload(input.payload);
  if (hashed.ok === false) return hashed;
  const body = acceptedTicket(input);
  if (body === undefined) return denial('APPROVAL_REQUIRED');
  const granted = await gate.resolve(input, deps.now());
  if (!granted.ok) return authorityDenial(granted.code);
  const decision = deps.decide({ facts: granted.facts });
  if (decision.effect !== 'allow') return denial('POLICY_DENIED');
  input.signal?.throwIfAborted();
  const at = deps.now();
  const approval = await deps.store.read(input.approvalId);
  if (approval !== undefined && !gate.requesterMatches(approval, granted.subject)) {
    return authorityDenial('AUTHORITY_DENIED');
  }
  const claim = await deps.store.claim({
    approvalId: input.approvalId,
    callId: input.id,
    taskId: input.taskId,
    stepId: input.stepId,
    toolRef: input.toolRef,
    idempotencyKey: input.idempotencyKey,
    targetResource: input.targetResource,
    payloadSha256: hashed.digest,
    policyDecisionId: decision.decisionId,
    intendedAt: at,
    traceId: input.traceId,
    actorSub: granted.subject,
    approverAuthorized: deps.approverAuthorized,
    now: at,
  });
  const settled = settle(claim);
  if (settled !== undefined) return settled;
  input.signal?.throwIfAborted();
  const recorded = recordedCall({ ...input, actorSub: granted.subject }, claim);
  const intent = intentStamp(claim, decision.decisionId, at);
  const denyAfterClaim = (outcome: DeniedResult) =>
    recordDenial(deps, { ...recorded, actorSub: granted.subject }, hashed.digest, intent, outcome);
  if (!gate.resumerMatches(claim, granted.subject)) {
    return denyAfterClaim(authorityDenial('AUTHORITY_DENIED'));
  }
  await deps.ledger.append(intendedEvent(recorded, hashed.digest, intent.decisionId, intent.at));
  input.signal?.throwIfAborted();
  await (deps.beforeToolCall ?? beforeToolCall)(input);
  const stale = await revalidate(deps, gate, input, granted);
  if (stale !== undefined) return denyAfterClaim(stale);
  // Authority resolution above is the last await before the provider call. A revocation that lands
  // after it cannot be retracted from a call already accepted by the provider; the spec accepts that
  // race (specs/03-authority-security.md) and relies on reconciling completion rather than cancelling.
  const receipt = await deps.postTicket(body, input.idempotencyKey, input.signal);
  await deps.store.complete(input.id, receipt);
  return { ok: true, receipt, replay: false };
}

function authorityRequest(input: ExecuteInput): AuthorityRequest {
  return {
    claimedActor: input.actorSub,
    taskId: input.taskId,
    stepId: input.stepId,
    toolRef: input.toolRef,
    targetResource: input.targetResource,
    approvalId: input.approvalId,
    signal: input.signal,
  };
}

/**
 * The last check before the provider call: authority, policy and approval as they are now. The
 * approval is read first so that authority resolution is the final await before the call.
 */
async function revalidate(
  deps: BrokerDeps,
  gate: AuthorityGate,
  input: ExecuteInput,
  granted: Granted,
): Promise<DeniedResult | undefined> {
  const approval = await deps.store.read(input.approvalId);
  const at = deps.now();
  const fresh = await gate.resolve(input, at);
  if (!fresh.ok) return authorityDenial(fresh.code);
  if (fresh.subject !== granted.subject) return authorityDenial('AUTHORITY_DENIED');
  if (deps.decide({ facts: fresh.facts }).effect !== 'allow') return denial('POLICY_DENIED');
  if (approval === undefined) return denial('APPROVAL_REQUIRED');
  const standing = approvalStanding(approval, at, deps.approverAuthorized);
  if (standing !== 'valid') return denial(standing);
  if (!gate.requesterMatches(approval, granted.subject)) return authorityDenial('AUTHORITY_DENIED');
  return undefined;
}

/**
 * Terminal event for a call whose claim is already recorded as INTENDED. Pre-claim denials write
 * nothing: no tool_calls row exists, and the broker has never logged them. The id carries the code
 * and time so a retried denial adds its own row while an identical one is an idempotent replay.
 */
async function recordDenial(
  deps: BrokerDeps,
  call: ExecuteInput,
  digest: string,
  intent: { readonly decisionId: string },
  outcome: DeniedResult,
): Promise<DeniedResult> {
  const at = deps.now();
  await deps.ledger.append(
    outboxEventSchema.parse({
      destination: 'audit',
      event: {
        ...intendedEvent(call, digest, intent.decisionId, at).event,
        eventId: `denied:${call.id}:${outcome.code}:${at.toISOString()}`,
        eventType: 'tool.denied',
        outcome: `DENIED:${outcome.code}`,
      },
    }),
  );
  return outcome;
}

function authorityDenial(code: 'AUTHORITY_DENIED' | 'AUTHORITY_UNAVAILABLE'): DeniedResult {
  return denial(code, code === 'AUTHORITY_DENIED' ? 403 : 503);
}

function acceptedTicket(input: ExecuteInput): TicketBody | undefined {
  if (input.toolRef !== TICKET_TOOL) return undefined;
  const body = ticketBody(input.payload);
  if (body === undefined || body.project !== input.targetResource) return undefined;
  return body;
}

function settle(claim: ClaimOutcome): BrokerResult | undefined {
  switch (claim.kind) {
    case 'replay':
      return { ok: true, receipt: claim.receipt, replay: true };
    case 'duplicate':
      return denial('DUPLICATE_CALL', 409);
    case 'deny':
      return denial(claim.code);
    case 'missing':
      return denial('APPROVAL_REQUIRED');
    case 'intended':
    case 'resume':
      return undefined;
    default: {
      const unreachable: never = claim;
      return unreachable;
    }
  }
}

function recordedCall(input: ExecuteInput, claim: ClaimOutcome): ExecuteInput {
  if (claim.kind !== 'resume') return input;
  return { ...input, traceId: claim.traceId, actorSub: claim.actorSub };
}

function intentStamp(
  claim: ClaimOutcome,
  decisionId: string,
  at: Date,
): { readonly decisionId: string; readonly at: Date } {
  if (claim.kind !== 'resume') return { decisionId, at };
  return { decisionId: claim.policyDecisionId, at: new Date(claim.intendedAt) };
}

function hashPayload(payload: unknown): PayloadHash {
  try {
    return { ok: true, digest: canonicalPayloadSha256(payload) };
  } catch (error) {
    if (error instanceof NonCanonicalPayload) {
      return { ok: false, status: 422, code: 'NON_CANONICAL_PAYLOAD' };
    }
    throw error;
  }
}

function ticketBody(value: unknown): TicketBody | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
  if (!('summary' in value) || !('project' in value)) return undefined;
  if (typeof value.summary !== 'string' || value.summary.length === 0) return undefined;
  if (typeof value.project !== 'string' || value.project.length === 0) return undefined;
  return { summary: value.summary, project: value.project };
}

function intendedEvent(
  input: ExecuteInput,
  digest: string,
  decisionId: string,
  at: Date,
): ReturnType<typeof outboxEventSchema.parse> {
  return outboxEventSchema.parse({
    destination: 'audit',
    event: {
      eventId: `intended:${input.id}`,
      eventType: 'tool.intended',
      schemaVersion: '1',
      occurredAt: at.toISOString(),
      taskId: input.taskId,
      stepId: input.stepId,
      traceId: input.traceId,
      initiatorSubject: input.actorSub,
      agentPrincipal: 'agent:broker',
      tool: input.toolRef,
      policyDecisionId: decisionId,
      approvalId: input.approvalId,
      requestDigestSha256: digest,
      outcome: 'INTENDED',
      externalObjectRef: null,
      prevDigest: null,
    },
  });
}

function denial(code: BrokerCode, status = 422): DeniedResult {
  return { ok: false, status, code };
}
