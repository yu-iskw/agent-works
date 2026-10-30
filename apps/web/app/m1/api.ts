import { IAP_ASSERTION_HEADER } from '@agent-works/domain';
import { TEAMWORK_API_VERSION, taskDetailSchema } from '@agent-works/domain/teamwork';

import { segmentsFor } from './config.js';

import type { Segment, WebConfig } from './config.js';
import type { AssertionSigner, Session } from './identity.js';
import type { ApiResult } from '../workbench/api.js';
import type {
  CapabilityState,
  InboxItem,
  MessageView,
  PortableDefinition,
  SkillView,
  SourceCheck,
  TaskDetail,
  TaskSummary,
  TeammateView,
  TemplateView,
} from '@agent-works/domain/teamwork';
import type { PortableFinding } from '@agent-works/domain/teamwork-portable';

export type { ApiResult } from '../workbench/api.js';

export type Connection = {
  readonly provider: 'google' | 'github';
  readonly status: 'active' | 'revoked' | 'error' | 'not_connected';
  readonly account: string | null;
  readonly scopes: readonly string[];
  readonly connectedAt: string | null;
  readonly errorCode: string | null;
  readonly configured: boolean;
};

export type Readiness = {
  readonly segment: { readonly id: string; readonly name: string };
  readonly member: { readonly sub: string; readonly email: string };
  readonly identity: 'google' | 'local-test';
  readonly sourceMode: 'live' | 'fixture';
  readonly missingConfig: readonly string[];
  readonly model: {
    readonly modelId: string;
    readonly mode: 'vertex' | 'stub';
    readonly state: 'ready' | 'unverified' | 'error';
    readonly credentials: string;
    readonly callsUsed: number;
    readonly callsLimit: number;
    readonly concurrency: number;
    readonly lastCall: {
      readonly at: string;
      readonly outcome: string;
      readonly latencyMs: number | null;
      readonly modelVersion: string | null;
    } | null;
    readonly errorCode: string | null;
    readonly remediation: string | null;
  };
  readonly connections: readonly Connection[];
  readonly capabilities: readonly string[];
  readonly readOnly: boolean;
  readonly inbox: Readonly<Record<string, number>>;
  readonly sources: {
    readonly repositories: readonly string[];
    readonly issue: number | null;
    readonly pinnedRef: string | null;
    readonly dataset: string | null;
    readonly driveConfigured: boolean;
  };
};

export type Conversation = {
  readonly id: string;
  readonly teammateId: string;
  readonly messages: readonly MessageView[];
  readonly pendingReply: boolean;
  readonly tasks: readonly TaskSummary[];
};

export type ExportPreview = {
  readonly definition: PortableDefinition;
  readonly findings: readonly PortableFinding[];
  readonly json: string;
};

/**
 * The BFF's only route to a segment backend. The segment is chosen by id from the fixed registry
 * and only if the member belongs to it; every request carries a 60-second assertion whose
 * audience is that segment, so a token for one backend is useless at the other.
 */
export function createSegmentClient(
  config: WebConfig,
  signer: AssertionSigner,
  load: typeof fetch = fetch,
) {
  function segmentFor(session: Session, id: string): Segment | undefined {
    return segmentsFor(config, session.email).find((segment) => segment.id === id);
  }

  async function call<T>(
    session: Session,
    segmentId: string,
    method: 'GET' | 'POST',
    path: string,
    body?: unknown,
  ): Promise<ApiResult<T>> {
    const segment = segmentFor(session, segmentId);
    if (segment === undefined) return { ok: false, status: 404, error: 'segment_not_found' };
    let response: Response;
    try {
      response = await load(`${segment.url}/v1/teamwork${path}`, {
        method,
        headers: {
          [IAP_ASSERTION_HEADER]: signer.mint(session, segment.id),
          accept: 'application/json',
          ...(method === 'POST'
            ? { 'content-type': 'application/json', 'x-csrf-token': 'bff-validated' }
            : {}),
        },
        body: method === 'POST' ? JSON.stringify(body ?? {}) : undefined,
        signal: AbortSignal.timeout(20_000),
      });
    } catch {
      return { ok: false, status: 503, error: 'segment_unreachable' };
    }
    const payload = (await response.json().catch(() => undefined)) as
      Record<string, unknown> | undefined;
    // web checks the member's own session before any call, so a 401 here means the segment API
    // rejected web's assertion (for example right after a key rotation), not a signed-out member.
    if (response.status === 401) return { ok: false, status: 503, error: 'segment_auth_failed' };
    if (!response.ok)
      return {
        ok: false,
        status: response.status,
        error: typeof payload?.error === 'string' ? payload.error : 'unavailable',
      };
    if (payload?.apiVersion !== TEAMWORK_API_VERSION)
      return { ok: false, status: 502, error: 'bad_contract' };
    return { ok: true, value: payload as T };
  }

  return {
    segmentFor,
    me: (s: Session, seg: string) => call<Readiness>(s, seg, 'GET', '/me'),
    catalog: (s: Session, seg: string) =>
      call<{ templates: TemplateView[]; skills: SkillView[] }>(s, seg, 'GET', '/catalog'),
    skillVersions: (s: Session, seg: string, id: string) =>
      call<{ versions: SkillView[] }>(s, seg, 'GET', `/skills/${id}`),
    customizeSkill: (s: Session, seg: string, body: unknown) =>
      call<{ skill: SkillView }>(s, seg, 'POST', '/skills/customize', body),
    teammates: (s: Session, seg: string) =>
      call<{ teammates: TeammateView[] }>(s, seg, 'GET', '/teammates'),
    teammate: (s: Session, seg: string, id: string) =>
      call<{ teammate: TeammateView; conversation: Conversation }>(
        s,
        seg,
        'GET',
        `/teammates/${id}`,
      ),
    createTeammate: (s: Session, seg: string, body: unknown) =>
      call<{ teammate: TeammateView }>(s, seg, 'POST', '/teammates', body),
    starterTeam: (s: Session, seg: string) =>
      call<{ teammates: TeammateView[] }>(s, seg, 'POST', '/teammates/starter'),
    updateTeammate: (s: Session, seg: string, id: string, body: unknown) =>
      call<{ teammate: TeammateView }>(s, seg, 'POST', `/teammates/${id}`, body),
    setSkill: (s: Session, seg: string, id: string, body: unknown) =>
      call<{ teammate: TeammateView }>(s, seg, 'POST', `/teammates/${id}/skills`, body),
    exportTeammate: (s: Session, seg: string, id: string) =>
      call<{ export: ExportPreview }>(s, seg, 'GET', `/teammates/${id}/export`),
    importTeammate: (s: Session, seg: string, body: unknown) =>
      call<{ teammate: TeammateView; capabilities: CapabilityState[] }>(
        s,
        seg,
        'POST',
        '/import',
        body,
      ),
    postMessage: (s: Session, seg: string, conversationId: string, body: unknown) =>
      call<{ accepted: boolean }>(
        s,
        seg,
        'POST',
        `/conversations/${conversationId}/messages`,
        body,
      ),
    tasks: (s: Session, seg: string) => call<{ tasks: TaskSummary[] }>(s, seg, 'GET', '/tasks'),
    createTask: (s: Session, seg: string, body: unknown) =>
      call<{ task: TaskSummary }>(s, seg, 'POST', '/tasks', body),
    /** One owner-scoped row; what pollers need, without the full task detail. */
    taskVersion: (s: Session, seg: string, id: string) =>
      call<{ version: number; status: TaskSummary['status'] }>(
        s,
        seg,
        'GET',
        `/tasks/${id}/version`,
      ),
    async task(s: Session, seg: string, id: string): Promise<ApiResult<TaskDetail>> {
      const result = await call<unknown>(s, seg, 'GET', `/tasks/${id}`);
      if (!result.ok) return result;
      const parsed = taskDetailSchema.safeParse(result.value);
      return parsed.success
        ? { ok: true, value: parsed.data }
        : { ok: false, status: 502, error: 'bad_contract' };
    },
    command: (s: Session, seg: string, id: string, command: string, body?: unknown) =>
      call<{ task: TaskSummary }>(s, seg, 'POST', `/tasks/${id}/${command}`, body),
    inbox: (s: Session, seg: string) => call<{ items: InboxItem[] }>(s, seg, 'GET', '/inbox'),
    dismiss: (s: Session, seg: string, id: string) =>
      call<{ dismissed: boolean }>(s, seg, 'POST', `/inbox/${id}/dismiss`),
    connections: (s: Session, seg: string) =>
      call<{ connections: Connection[] }>(s, seg, 'GET', '/connections'),
    connectStart: (s: Session, seg: string, provider: string) =>
      call<{ url: string }>(s, seg, 'POST', `/connections/${provider}/start`),
    connectComplete: (s: Session, seg: string, provider: string, body: unknown) =>
      call<{ connection: Connection }>(s, seg, 'POST', `/connections/${provider}/complete`, body),
    checkSources: (s: Session, seg: string) =>
      call<{ checks: SourceCheck[] }>(s, seg, 'POST', '/sources/check'),
    disconnect: (s: Session, seg: string, provider: string) =>
      call<{ connections: Connection[] }>(s, seg, 'POST', `/connections/${provider}/disconnect`),
    fixtureDoc: (s: Session, seg: string, id: string) =>
      call<{ title: string; markdown: string; createdAt: string }>(
        s,
        seg,
        'GET',
        `/fixture-docs/${id}`,
      ),
  };
}

export type SegmentClient = ReturnType<typeof createSegmentClient>;
