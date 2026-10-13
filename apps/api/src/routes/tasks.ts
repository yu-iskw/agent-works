import { IAP_ASSERTION_HEADER, taskApiSchema, terminalStatuses } from '@agent-works/domain';
import { decide } from '@agent-works/policy';

import { rolesAt } from '../auth/directory.js';
import { Unauthenticated, Unavailable, createIapVerifier } from '../auth/iap.js';
import { headerValue } from '../http.js';
import { ConcurrentUpdate, LedgerConflict } from '../ports/ledger-port.js';
import { createMemoryTaskPorts } from '../ports/memory/task-ports.js';
import { askPolicy, contextFor } from '../retrieval/search.js';
import { createSkillRegistry } from '../skills/registry.js';

import type { Caller, VerifyAssertion } from '../auth/iap.js';
import type { ApiReply, Route } from '../http.js';
import type { AskDeps } from './ask.js';
import type { DispatchPort } from '../ports/dispatch-port.js';
import type { LedgerPort } from '../ports/ledger-port.js';
import type { AuthorizedCaller, RegisteredSkill } from '../skills/incident.js';
import type { SkillRegistry } from '../skills/registry.js';
import type { Task, TaskApi, TaskSubmit } from '@agent-works/domain';

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

export type TaskAuthorization = {
  readonly now: AskDeps['now'];
  readonly wire?: Pick<NonNullable<AskDeps['wire']>, 'groups' | 'policyInput'>;
};

export type TaskRoutes = {
  readonly submit: Route;
  readonly read: Route;
  readonly events: Route;
  readonly cancel?: Route;
};

export function createTaskRoutes(
  ledger: LedgerPort,
  verify: VerifyAssertion,
  registry: SkillRegistry = createSkillRegistry(),
  authorization?: TaskAuthorization,
  dispatch?: DispatchPort,
): TaskRoutes {
  return {
    submit: (request) => submitTask(dispatch, verify, request, { registry, authorization }),
    read: (request) => readTask(ledger, verify, request),
    events: (request) => readEvents(ledger, verify, request),
    cancel: (request) => cancelTask(ledger, verify, request),
  };
}

const memory = createMemoryTaskPorts();
const shared = createTaskRoutes(
  memory.ledger,
  envVerifier(),
  undefined,
  undefined,
  memory.dispatch,
);

export const taskSubmitRoute = shared.submit;
export const taskReadRoute = shared.read;
export const taskEventsRoute = shared.events;

async function submitTask(
  dispatch: DispatchPort | undefined,
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
  if (dispatch === undefined) return unavailable;
  return accept(
    dispatch,
    subject,
    submission,
    { idempotencyKey, skill, authorized },
    acceptanceClock(options.authorization),
  );
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
  port: DispatchPort,
  subject: string,
  request: TaskSubmit,
  dispatch: {
    readonly idempotencyKey: string;
    readonly skill: RegisteredSkill;
    readonly authorized: AuthorizedCaller;
  },
  now: () => Date,
): Promise<ApiReply> {
  try {
    const accepted = await port.accept({
      subject,
      request,
      idempotencyKey: dispatch.idempotencyKey,
      policy: dispatch.authorized.decision,
      context: dispatch.authorized.context,
      agent: {
        kind: 'agent',
        agentId: dispatch.skill.manifest.id,
        version: dispatch.skill.manifest.version,
        identityRef: `agent://${dispatch.skill.manifest.id}`,
      },
      deadline: new Date(
        now().getTime() + request.executionPolicy.deadlineSeconds * 1000,
      ).toISOString(),
    });
    return { status: 200, body: { kind: 'accepted', ...accepted } };
  } catch (error) {
    if (error instanceof LedgerConflict) return conflict;
    if (error instanceof Unavailable) return unavailable;
    throw error;
  }
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
  verify: VerifyAssertion,
  request: ApiRequest,
): Promise<ApiReply> {
  const opened = await openTask(ledger, verify, request);
  if (opened.ok === false) return opened.reply;
  return {
    status: 200,
    body: { events: (await ledger.events?.(opened.task.createdBySub, opened.task.id)) ?? [] },
  };
}

type Opened =
  | { readonly ok: true; readonly task: Task }
  | { readonly ok: false; readonly reply: ApiReply };

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

function pathTaskId(path: string): string | undefined {
  const suffix = path.endsWith(':cancel') ? ':cancel' : eventsSuffix;
  const trimmed = path.endsWith(suffix) ? path.slice(0, -suffix.length) : path;
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

function acceptanceClock(authorization?: TaskAuthorization): () => Date {
  return authorization?.now ?? (() => new Date());
}

async function cancelTask(
  ledger: LedgerPort,
  verify: VerifyAssertion,
  request: ApiRequest,
): Promise<ApiReply> {
  const opened = await openTask(ledger, verify, request);
  if (!opened.ok) return opened.reply;
  if (!headerValue(request.headers, idempotencyHeader)) return invalidRequest;
  if (ledger.transition === undefined) return unavailable;
  const task = opened.task;
  if (terminalStatuses.includes(task.status))
    return { status: 200, body: { taskId: task.id, status: task.status } };
  const submitted = await ledger.readOutbox(`submit:${task.id}`);
  if (submitted === undefined) return unavailable;
  try {
    await ledger.transition({
      subject: task.createdBySub,
      taskId: task.id,
      expectedVersion: task.version,
      to: 'CANCELLED',
      event: {
        ...submitted,
        event: {
          ...submitted.event,
          eventId: `cancel:${task.id}`,
          eventType: 'task.cancelled',
          stepId: 'cancel',
          occurredAt: new Date().toISOString(),
        },
      },
    });
    return { status: 200, body: { taskId: task.id, status: 'CANCELLED' } };
  } catch (error) {
    if (error instanceof ConcurrentUpdate) return conflict;
    throw error;
  }
}
