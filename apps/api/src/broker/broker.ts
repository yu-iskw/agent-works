import {
  NonCanonicalPayload,
  canonicalPayloadSha256,
  outboxEventSchema,
  ticketCreateManifest,
} from '@agent-works/domain';

import { beforeToolCall } from '../suspension/runtime.js';

import { resolveAuthority } from './authority.js';

import type { ApprovalStore, BindResult, ClaimOutcome, DecisionCommand } from './approvals.js';
import type { AuthorityRequest, AuthorityResolver, AuthorityVerdict } from './authority.js';
import type { LedgerPort } from '../ports/ledger-port.js';
import type { PolicyDecision } from '@agent-works/domain';
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
  /** A claim. With `BrokerDeps.authorize` it must equal the server-resolved subject, else the call is denied. */
  readonly actorSub: string;
  readonly traceId: string;
  /** A claim. With `BrokerDeps.authorize` the server-resolved facts replace it. */
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

type BrokerResult =
  | { readonly ok: true; readonly receipt: string; readonly replay: boolean }
  | { readonly ok: false; readonly status: number; readonly code: BrokerCode };

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
  readonly postTicket: (payload: TicketBody, idempotencyKey: string) => Promise<string>;
  readonly approverAuthorized: (sub: string) => boolean;
  /**
   * Server-side authority resolution. When set, actor and policy facts come from it, authority is
   * checked before the claim and again right before the provider call, and any failure to resolve
   * denies. Production wiring must set it; without it the caller's `actorSub` and `facts` are trusted.
   */
  readonly authorize?: AuthorityResolver;
  readonly now: () => Date;
};

export function createBroker(deps: BrokerDeps): Broker {
  const activeCalls = new Set<string>();
  const activeKeys = new Set<string>();
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
        return await execute(deps, input);
      } finally {
        activeCalls.delete(input.id);
        activeKeys.delete(input.idempotencyKey);
      }
    },
  };
}

async function execute(deps: BrokerDeps, input: ExecuteInput): Promise<BrokerResult> {
  const hashed = hashPayload(input.payload);
  if (hashed.ok === false) return hashed;
  const body = acceptedTicket(input);
  if (body === undefined) return denial('APPROVAL_REQUIRED');
  const gate = await authorityGate(deps, input, deps.now());
  if (!gate.ok) return authorityDenial(gate.code);
  const decision = deps.decide({ facts: gate.facts });
  if (decision.effect !== 'allow') return denial('POLICY_DENIED');
  input.signal?.throwIfAborted();
  const at = deps.now();
  if (await requesterMismatch(deps, input, gate.subject))
    return authorityDenial('AUTHORITY_DENIED');
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
    actorSub: gate.subject,
    approverAuthorized: deps.approverAuthorized,
    now: at,
  });
  const settled = settle(claim);
  if (settled !== undefined) return settled;
  input.signal?.throwIfAborted();
  if (resumedByOther(deps, claim, gate.subject)) return authorityDenial('AUTHORITY_DENIED');
  const recorded = recordedCall({ ...input, actorSub: gate.subject }, claim);
  const intent = intentStamp(claim, decision.decisionId, at);
  await deps.ledger.append(intendedEvent(recorded, hashed.digest, intent.decisionId, intent.at));
  input.signal?.throwIfAborted();
  await (deps.beforeToolCall ?? beforeToolCall)(input);
  const stale = await revalidate(deps, input, gate);
  if (stale !== undefined) return stale;
  const receipt = await deps.postTicket(body, input.idempotencyKey);
  await deps.store.complete(input.id, receipt);
  return { ok: true, receipt, replay: false };
}

function authorityGate(deps: BrokerDeps, input: ExecuteInput, at: Date): Promise<AuthorityVerdict> {
  if (deps.authorize === undefined) {
    return Promise.resolve({ ok: true, subject: input.actorSub, facts: input.facts });
  }
  return resolveAuthority(deps.authorize, authorityRequest(input), at);
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

/** The last check before the provider call: authority, policy and approval as they are now. */
async function revalidate(
  deps: BrokerDeps,
  input: ExecuteInput,
  gate: Extract<AuthorityVerdict, { ok: true }>,
): Promise<BrokerResult | undefined> {
  const at = deps.now();
  const fresh = await authorityGate(deps, input, at);
  if (!fresh.ok) return authorityDenial(fresh.code);
  if (fresh.subject !== gate.subject) return authorityDenial('AUTHORITY_DENIED');
  if (deps.decide({ facts: fresh.facts }).effect !== 'allow') return denial('POLICY_DENIED');
  const approval = await deps.store.read(input.approvalId);
  if (approval?.state !== 'approved') return denial('APPROVAL_REQUIRED');
  if (Date.parse(approval.expiresAt) <= at.getTime()) return denial('APPROVAL_EXPIRED');
  if (approval.approverSub === null || !deps.approverAuthorized(approval.approverSub)) {
    return denial('APPROVAL_REQUIRED');
  }
  if (deps.authorize !== undefined && approval.requestedBySub !== gate.subject) {
    return authorityDenial('AUTHORITY_DENIED');
  }
  return undefined;
}

async function requesterMismatch(
  deps: BrokerDeps,
  input: ExecuteInput,
  subject: string,
): Promise<boolean> {
  if (deps.authorize === undefined) return false;
  const requester = (await deps.store.read(input.approvalId))?.requestedBySub;
  return requester !== undefined && requester !== subject;
}

function resumedByOther(deps: BrokerDeps, claim: ClaimOutcome, subject: string): boolean {
  return deps.authorize !== undefined && claim.kind === 'resume' && claim.actorSub !== subject;
}

function authorityDenial(code: 'AUTHORITY_DENIED' | 'AUTHORITY_UNAVAILABLE'): BrokerResult {
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

function denial(code: BrokerCode, status = 422): BrokerResult {
  return { ok: false, status, code };
}
