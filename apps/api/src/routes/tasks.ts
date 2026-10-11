import { IAP_ASSERTION_HEADER, canonicalPayloadSha256, taskApiSchema } from '@agent-works/domain';
import { decide } from '@agent-works/policy';

import { rolesAt } from '../auth/directory.js';
import { Unauthenticated, Unavailable, createIapVerifier } from '../auth/iap.js';
import { headerValue } from '../http.js';
import { LedgerConflict } from '../ports/ledger-port.js';
import { createMemoryLedgerPort } from '../ports/memory/ledger-port.js';
import { askPolicy, contextFor } from '../retrieval/search.js';
import { createSkillRegistry } from '../skills/registry.js';

import type { Caller, VerifyAssertion } from '../auth/iap.js';
import type { ApiReply, Route } from '../http.js';
import type { AskDeps } from './ask.js';
import type { LedgerPort } from '../ports/ledger-port.js';
import type { AuthorizedCaller, RegisteredSkill } from '../skills/incident.js';
import type { SkillRegistry } from '../skills/registry.js';
import type { OutboxEvent, Task, TaskAccepted, TaskApi, TaskSubmit } from '@agent-works/domain';

const unauthenticated = {
  status: 401,
  body: { error: 'unauthenticated' },
} as const satisfies ApiReply;
const invalidRequest = {
  status: 400,
  body: { error: 'invalid_request' },
} as const satisfies ApiReply;
const conflict = { status: 409, body: { error: 'conflict' } } as const satisfies ApiReply;
const untrustedField = {
  status: 422,
  body: { error: 'untrusted_field' },
} as const satisfies ApiReply;
const notFound = { status: 404, body: { error: 'not_found' } } as const satisfies ApiReply;
const unavailable = { status: 503, body: { error: 'unavailable' } } as const satisfies ApiReply;

const idempotencyHeader = 'idempotency-key';
const taskPathPrefix = '/v1/tasks/';
const eventsSuffix = '/events';
const trustedFields = new Set(['userId', 'agentIdentity', 'scopes']);

type ApiRequest = Parameters<Route>[0];
type EventLog = Map<string, readonly OutboxEvent[]>;

export type TaskAuthorization = {
  readonly now: AskDeps['now'];
  readonly wire?: Pick<NonNullable<AskDeps['wire']>, 'groups' | 'policyInput'>;
};

export type TaskRoutes = {
  readonly submit: Route;
  readonly read: Route;
  readonly events: Route;
};

export function createTaskRoutes(
  ledger: LedgerPort,
  verify: VerifyAssertion,
  registry: SkillRegistry = createSkillRegistry(),
  authorization?: TaskAuthorization,
): TaskRoutes {
  const events: EventLog = new Map();
  return {
    submit: (request) => submitTask(ledger, events, verify, request, { registry, authorization }),
    read: (request) => readTask(ledger, verify, request),
    events: (request) => readEvents(ledger, events, verify, request),
  };
}

const shared = createTaskRoutes(createMemoryLedgerPort(), envVerifier());

export const taskSubmitRoute = shared.submit;
export const taskReadRoute = shared.read;
export const taskEventsRoute = shared.events;

async function submitTask(
  ledger: LedgerPort,
  events: EventLog,
  verify: VerifyAssertion,
  request: ApiRequest,
  options: { readonly registry: SkillRegistry; readonly authorization?: TaskAuthorization },
): Promise<ApiReply> {
  const caller = await authenticate(verify, request);
  if ('status' in caller) return caller;
  const subject = caller.sub;
  const body = parseJson(request.body);
  if (hasTrustedField(body)) return untrustedField;
  const parsed = taskApiSchema.safeParse(body);
  if (!parsed.success || !('kind' in parsed.data) || parsed.data.kind !== 'submit')
    return invalidRequest;
  const idempotencyKey = headerValue(request.headers, idempotencyHeader);
  if (idempotencyKey === undefined || idempotencyKey.length === 0) return invalidRequest;
  const skill = options.registry.get(parsed.data.skillId);
  if (skill === undefined) return { status: 400, body: { error: 'unknown_skill' } };
  const submission = submitBody(parsed.data);
  if (!skill.validate(submission)) return invalidRequest;
  const authorized = await authorize(caller, submission, skill, options.authorization);
  if (authorized === undefined) return { status: 403, body: { error: 'denied' } };
  return accept(ledger, events, subject, submission, { idempotencyKey, skill, authorized });
}

async function authorize(
  caller: Caller,
  request: TaskSubmit,
  skill: RegisteredSkill,
  deps?: TaskAuthorization,
): Promise<AuthorizedCaller | undefined> {
  try {
    if (deps?.wire === undefined) return undefined;
    const snapshot = await deps.wire.groups(caller);
    const roles = rolesAt(snapshot, deps.now().getTime());
    const context = contextFor(caller, snapshot, {
      ...askPolicy,
      taskPurpose: skill.manifest.id,
      allowedSources: request.sourceAllowlist,
    });
    const input = await deps.wire.policyInput?.(caller, context, {
      request,
      manifest: skill.manifest,
    });
    const decision = decide({
      facts: {
        ...input?.facts,
        authenticated_actor: caller.sub.length > 0,
        active_org_membership: roles.length > 0,
        permitted_app_role: roles.includes('Employee'),
      },
    });
    if (decision.effect !== 'allow') return undefined;
    return { caller, context, decision };
  } catch {
    return undefined;
  }
}

async function accept(
  ledger: LedgerPort,
  events: EventLog,
  subject: string,
  request: TaskSubmit,
  dispatch: {
    readonly idempotencyKey: string;
    readonly skill: RegisteredSkill;
    readonly authorized: AuthorizedCaller;
  },
): Promise<ApiReply> {
  try {
    const accepted = await ledger.submit(subject, request, dispatch.idempotencyKey);
    await recordSubmit(ledger, events, subject, accepted, request);
    await dispatch.skill.dispatch(request, accepted, dispatch.authorized);
    return { status: 200, body: { kind: 'accepted', ...accepted } };
  } catch (error) {
    if (error instanceof LedgerConflict) return conflict;
    if (error instanceof Unavailable) return unavailable;
    throw error;
  }
}

async function recordSubmit(
  ledger: LedgerPort,
  events: EventLog,
  subject: string,
  accepted: TaskAccepted,
  request: TaskSubmit,
): Promise<void> {
  const recorded = submitEvent(subject, accepted, request);
  await ledger.append(recorded);
  if (!events.has(accepted.taskId)) events.set(accepted.taskId, [recorded]);
}

async function readTask(
  ledger: LedgerPort,
  verify: VerifyAssertion,
  request: ApiRequest,
): Promise<ApiReply> {
  const opened = await openTask(ledger, verify, request);
  if (opened.ok === false) return opened.reply;
  return { status: 200, body: opened.task };
}

async function readEvents(
  ledger: LedgerPort,
  events: EventLog,
  verify: VerifyAssertion,
  request: ApiRequest,
): Promise<ApiReply> {
  const opened = await openTask(ledger, verify, request);
  if (opened.ok === false) return opened.reply;
  return { status: 200, body: { events: events.get(opened.task.id) ?? [] } };
}

type Opened =
  { readonly ok: true; readonly task: Task } | { readonly ok: false; readonly reply: ApiReply };

async function openTask(
  ledger: LedgerPort,
  verify: VerifyAssertion,
  request: ApiRequest,
): Promise<Opened> {
  const caller = await authenticate(verify, request);
  if ('status' in caller) return { ok: false, reply: caller };
  const subject = caller.sub;
  const taskId = pathTaskId(request.path);
  if (taskId === undefined) return { ok: false, reply: notFound };
  const task = await ledger.read(subject, taskId);
  if (task === undefined) return { ok: false, reply: notFound };
  return { ok: true, task };
}

function submitBody(data: Extract<TaskApi, { kind: 'submit' }>): TaskSubmit {
  return {
    objective: data.objective,
    skillId: data.skillId,
    ...(data.input === undefined ? {} : { input: data.input }),
    sourceAllowlist: data.sourceAllowlist,
    requestedOutputs: data.requestedOutputs,
    executionPolicy: data.executionPolicy,
  };
}

function submitEvent(subject: string, accepted: TaskAccepted, request: TaskSubmit): OutboxEvent {
  return {
    destination: 'work',
    event: {
      eventId: `submit:${accepted.taskId}`,
      eventType: 'task.submitted',
      schemaVersion: '1',
      occurredAt: accepted.submittedAt,
      taskId: accepted.taskId,
      stepId: 'submit',
      traceId: accepted.traceId,
      initiatorSubject: subject,
      agentPrincipal: 'agent:memory',
      tool: null,
      policyDecisionId: null,
      approvalId: null,
      requestDigestSha256: canonicalPayloadSha256(request),
      outcome: 'SUCCESS',
      externalObjectRef: null,
      prevDigest: null,
    },
  };
}

function pathTaskId(path: string): string | undefined {
  const trimmed = path.endsWith(eventsSuffix) ? path.slice(0, -eventsSuffix.length) : path;
  if (!trimmed.startsWith(taskPathPrefix)) return undefined;
  const taskId = trimmed.slice(taskPathPrefix.length);
  if (taskId.length === 0 || taskId.includes('/')) return undefined;
  return taskId;
}

function hasTrustedField(value: unknown): boolean {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  return Object.keys(value).some((key) => trustedFields.has(key));
}

async function authenticate(
  verify: VerifyAssertion,
  request: ApiRequest,
): Promise<Caller | ApiReply> {
  try {
    return await verify(headerValue(request.headers, IAP_ASSERTION_HEADER));
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

function parseJson(body: Buffer): unknown {
  if (body.length === 0) return undefined;
  try {
    return JSON.parse(body.toString('utf8')) as unknown;
  } catch {
    return undefined;
  }
}
