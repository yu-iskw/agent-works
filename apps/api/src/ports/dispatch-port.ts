import {
  canonicalPayloadSha256,
  deliveryPayload,
  fencingToken,
  outboxEventSchema,
  policyDecisionSchema,
  principalSchema,
  taskSubmitSchema,
  terminalStatuses,
} from '@agent-works/domain';
import * as z from 'zod';

import { LedgerConflict } from './ledger-port.js';

import type { TaskLedger } from './ledger-port.js';
import type {
  ClaimedDelivery,
  DeliveryPayload,
  FencingToken,
  LeaseProof,
  OutboxEvent,
  PolicyDecision,
  Principal,
  Task,
  TaskAccepted,
  TaskStatus,
  TaskSubmit,
} from '@agent-works/domain';

const instant = z.iso.datetime();
const changedBody = 'task body changed';
const staleFence = 'stale fencing token';

export class DispatchInjectedFault extends Error {
  constructor() {
    super('injected fault');
    this.name = 'DispatchInjectedFault';
  }
}

export type DispatchSeam = {
  failAfterTaskInsert: boolean;
};

export type AcceptTask = {
  readonly subject: string;
  readonly idempotencyKey: string;
  readonly request: TaskSubmit;
  readonly policy: PolicyDecision;
  readonly agent: Principal;
  readonly deadline: string;
};

export type ParsedAccept = {
  readonly subject: string;
  readonly idempotencyKey: string;
  readonly request: TaskSubmit;
  readonly policy: PolicyDecision;
  readonly agent: Principal;
  readonly deadline: string;
  readonly payload: DeliveryPayload;
  readonly digest: string;
};

export interface DispatchPort {
  accept(input: AcceptTask): Promise<TaskAccepted>;
  claim(workerId: string, leaseMs: number): Promise<ClaimedDelivery | undefined>;
  renew(lease: LeaseProof, leaseMs: number): Promise<ClaimedDelivery>;
  release(lease: LeaseProof): Promise<LeaseProof>;
  scheduleRetry(lease: LeaseProof, at: string, attempt: number): Promise<LeaseProof>;
}

export type DispatchHarness = {
  open(): { dispatch: DispatchPort; ledger: TaskLedger };
  restart(): { dispatch: DispatchPort; ledger: TaskLedger };
  setNow(iso: string): void;
  failNextAcceptAfterTaskInsert(): void;
  counts(): Promise<{ tasks: number; outbox: number; deliveries: number }>;
};

const harnessOrigin = '2026-10-10T10:00:00.000Z';

export function createDispatchHarness(
  openPorts: (
    now: () => Date,
    seam: DispatchSeam,
  ) => { dispatch: DispatchPort; ledger: TaskLedger },
  counts: () => Promise<{ tasks: number; outbox: number; deliveries: number }>,
): DispatchHarness {
  const seam: DispatchSeam = { failAfterTaskInsert: false };
  let instant = new Date(harnessOrigin);
  const now = () => instant;
  const open = () => openPorts(now, seam);
  return {
    open,
    restart: open,
    setNow(iso) {
      instant = new Date(iso);
    },
    failNextAcceptAfterTaskInsert() {
      seam.failAfterTaskInsert = true;
    },
    counts,
  };
}

export type DeliveryRow = {
  readonly taskId: string;
  readonly payload: DeliveryPayload;
  readonly availableAt: Date;
  readonly attempt: number;
  readonly workerId: string | undefined;
  readonly leaseUntil: Date | undefined;
  readonly fencingToken: number;
};

export type LeaseCommand =
  | { readonly kind: 'claim'; readonly workerId: string; readonly leaseMs: number }
  | { readonly kind: 'renew'; readonly lease: LeaseProof; readonly leaseMs: number }
  | { readonly kind: 'release'; readonly lease: LeaseProof }
  | {
      readonly kind: 'scheduleRetry';
      readonly lease: LeaseProof;
      readonly at: string;
      readonly attempt: number;
    };

export type LeaseDecision =
  | { readonly kind: 'ok'; readonly row: DeliveryRow; readonly claimed: ClaimedDelivery }
  | { readonly kind: 'miss' }
  | { readonly kind: 'conflict' };

export function parseAccept(input: AcceptTask): ParsedAccept {
  const request = definedRequest(taskSubmitSchema.parse(input.request));
  const policy = policyDecisionSchema.parse(input.policy);
  const agent = principalSchema.parse(input.agent);
  const deadline = instant.parse(input.deadline);
  const payload = deliveryPayload(payloadValue(input.subject, request, policy, agent, deadline));
  const digest = canonicalPayloadSha256({ request, policy, agent, deadline });
  return {
    subject: input.subject,
    idempotencyKey: input.idempotencyKey,
    request,
    policy,
    agent,
    deadline,
    payload,
    digest,
  };
}

export function submittedEvent(parsed: ParsedAccept, task: Task): OutboxEvent {
  return outboxEventSchema.parse({
    destination: 'work',
    event: {
      eventId: `submit:${task.id}`,
      eventType: 'task.submitted',
      schemaVersion: '1',
      occurredAt: task.createdAt,
      taskId: task.id,
      stepId: 'submit',
      traceId: task.id.replaceAll('-', ''),
      initiatorSubject: parsed.subject,
      agentPrincipal: principalRef(parsed.agent),
      tool: null,
      policyDecisionId: parsed.policy.decisionId,
      approvalId: null,
      requestDigestSha256: canonicalPayloadSha256(parsed.request),
      outcome: 'SUCCESS',
      externalObjectRef: null,
      prevDigest: null,
    },
  });
}

export function requireLeaseMs(leaseMs: number): number {
  if (!Number.isInteger(leaseMs) || leaseMs < 1) throw new RangeError('leaseMs');
  return leaseMs;
}

export function requireAttempt(attempt: number): number {
  if (!Number.isInteger(attempt) || attempt < 0) throw new RangeError('attempt');
  return attempt;
}

export function requireInstant(value: string): Date {
  if (!instant.safeParse(value).success) throw new RangeError('at');
  return new Date(value);
}

export function requireProof(lease: LeaseProof): LeaseProof {
  return {
    taskId: lease.taskId,
    workerId: lease.workerId,
    fencingToken: fencingToken(lease.fencingToken),
  };
}

export function proofOf(claimed: ClaimedDelivery): LeaseProof {
  return {
    taskId: claimed.taskId,
    workerId: claimed.workerId,
    fencingToken: claimed.fencingToken,
  };
}

export function applyLease(
  row: DeliveryRow,
  status: TaskStatus,
  command: LeaseCommand,
  now: Date,
): LeaseDecision {
  switch (command.kind) {
    case 'claim':
      return decideClaim(row, status, command, now);
    case 'renew':
      return decideRenew(row, command, now);
    case 'release':
      return decideRelease(row, command);
    case 'scheduleRetry':
      return decideRetry(row, status, command);
    default: {
      const unexpected: never = command;
      return unexpected;
    }
  }
}

export function leaseConflict(): LedgerConflict {
  return new LedgerConflict(staleFence);
}

export function bodyConflict(): LedgerConflict {
  return new LedgerConflict(changedBody);
}

function decideClaim(
  row: DeliveryRow,
  status: TaskStatus,
  command: Extract<LeaseCommand, { kind: 'claim' }>,
  now: Date,
): LeaseDecision {
  if (!canClaim(row, status, now)) return { kind: 'miss' };
  const token = fencingToken(row.fencingToken + 1);
  const next = hold(row, command.workerId, new Date(now.getTime() + command.leaseMs), token);
  return { kind: 'ok', row: next, claimed: claimedDelivery(next, command.workerId, token) };
}

function decideRenew(
  row: DeliveryRow,
  command: Extract<LeaseCommand, { kind: 'renew' }>,
  now: Date,
): LeaseDecision {
  if (!sameHolder(row, command.lease) || !liveLease(row, now)) return { kind: 'conflict' };
  const token = command.lease.fencingToken;
  const next = hold(row, command.lease.workerId, new Date(now.getTime() + command.leaseMs), token);
  return { kind: 'ok', row: next, claimed: claimedDelivery(next, command.lease.workerId, token) };
}

function decideRelease(
  row: DeliveryRow,
  command: Extract<LeaseCommand, { kind: 'release' }>,
): LeaseDecision {
  if (!sameHolder(row, command.lease)) return { kind: 'conflict' };
  const token = fencingToken(row.fencingToken + 1);
  const next: DeliveryRow = {
    ...row,
    workerId: undefined,
    leaseUntil: undefined,
    fencingToken: token,
  };
  return { kind: 'ok', row: next, claimed: claimedDelivery(row, command.lease.workerId, token) };
}

function decideRetry(
  row: DeliveryRow,
  status: TaskStatus,
  command: Extract<LeaseCommand, { kind: 'scheduleRetry' }>,
): LeaseDecision {
  if (!sameHolder(row, command.lease) || terminalStatuses.includes(status)) {
    return { kind: 'conflict' };
  }
  const token = fencingToken(row.fencingToken + 1);
  const next: DeliveryRow = {
    ...row,
    workerId: undefined,
    leaseUntil: undefined,
    availableAt: new Date(command.at),
    attempt: command.attempt,
    fencingToken: token,
  };
  return {
    kind: 'ok',
    row: next,
    claimed: {
      taskId: row.taskId,
      workerId: command.lease.workerId,
      fencingToken: token,
      leaseUntil: command.at,
      attempt: command.attempt,
      payload: row.payload,
    },
  };
}

function canClaim(row: DeliveryRow, status: TaskStatus, now: Date): boolean {
  if (row.availableAt.getTime() > now.getTime()) return false;
  if (liveLease(row, now)) return false;
  return !terminalStatuses.includes(status);
}

function liveLease(row: DeliveryRow, now: Date): boolean {
  return row.leaseUntil !== undefined && row.leaseUntil.getTime() > now.getTime();
}

function sameHolder(row: DeliveryRow, lease: LeaseProof): boolean {
  return row.workerId === lease.workerId && row.fencingToken === lease.fencingToken;
}

function hold(
  row: DeliveryRow,
  workerId: string,
  leaseUntil: Date,
  token: FencingToken,
): DeliveryRow {
  return { ...row, workerId, leaseUntil, fencingToken: token };
}

function claimedDelivery(row: DeliveryRow, workerId: string, token: FencingToken): ClaimedDelivery {
  return {
    taskId: row.taskId,
    workerId,
    fencingToken: token,
    leaseUntil: row.leaseUntil?.toISOString() ?? row.availableAt.toISOString(),
    attempt: row.attempt,
    payload: row.payload,
  };
}

function definedRequest(request: TaskSubmit): TaskSubmit {
  if (request.input !== undefined) return request;
  return {
    objective: request.objective,
    skillId: request.skillId,
    sourceAllowlist: request.sourceAllowlist,
    requestedOutputs: request.requestedOutputs,
    executionPolicy: request.executionPolicy,
  };
}

function payloadValue(
  subject: string,
  request: TaskSubmit,
  policy: PolicyDecision,
  agent: Principal,
  deadline: string,
): unknown {
  const base = { subject, policy, agent, deadline };
  if (request.input === undefined) return base;
  return { ...base, input: request.input };
}

function principalRef(agent: Principal): string {
  switch (agent.kind) {
    case 'human':
      return `human:${agent.sub}`;
    case 'agent':
      return `agent:${agent.agentId}`;
    case 'serviceWorkflow':
      return `workflow:${agent.workflowId}`;
    default: {
      const unexpected: never = agent;
      return unexpected;
    }
  }
}
