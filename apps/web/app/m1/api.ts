import { IAP_ASSERTION_HEADER } from '@agent-works/domain';
import { marketplaceDetailSchema, marketplaceListingSchema } from '@agent-works/domain/marketplace';
import { TEAMWORK_API_VERSION, taskDetailSchema } from '@agent-works/domain/teamwork';

import { segmentsFor } from './config.js';

import type { Segment, WebConfig } from './config.js';
import type { AssertionSigner, Session } from './identity.js';
import type { ApiResult } from '../workbench/api.js';
import type {
  InstallationView,
  MarketplaceDetail,
  MarketplaceKind,
  MarketplaceListing,
} from '@agent-works/domain/marketplace';
import type {
  AttachmentView,
  CapabilityState,
  InboxItem,
  MessageView,
  PortableDefinition,
  ResultEntry,
  SkillView,
  SourceCheck,
  TaskDetail,
  TaskSummary,
  TeammateView,
  TemplateView,
} from '@agent-works/domain/teamwork';
import type { PortableFinding } from '@agent-works/domain/teamwork-portable';

export type { ApiResult } from '../workbench/api.js';

const TEAMMATES = '/teammates';

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
        ...(typeof payload?.detail === 'string' ? { detail: payload.detail.slice(0, 300) } : {}),
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
      call<{ teammates: TeammateView[] }>(s, seg, 'GET', TEAMMATES),
    /** The listing as the segment sends it; the workspace loader parses it loosely. */
    teammateRows: (s: Session, seg: string) => call<unknown>(s, seg, 'GET', TEAMMATES),
    /** One conversation page with an after-cursor; 404 until the segment serves paging. */
    /** `after` polls for newer messages, `before` pages back; at most one of them is set. */
    conversationPage: (
      s: Session,
      seg: string,
      id: string,
      cursor: { readonly after: string | null; readonly before: string | null },
    ) => {
      const query =
        cursor.after !== null
          ? `?after=${encodeURIComponent(cursor.after)}`
          : cursor.before !== null
            ? `?before=${encodeURIComponent(cursor.before)}`
            : '';
      return call<unknown>(s, seg, 'GET', `/conversations/${id}${query}`);
    },
    teammate: (s: Session, seg: string, id: string) =>
      call<{ teammate: TeammateView; conversation: Conversation }>(
        s,
        seg,
        'GET',
        `/teammates/${id}`,
      ),
    createTeammate: (s: Session, seg: string, body: unknown) =>
      call<{ teammate: TeammateView }>(s, seg, 'POST', TEAMMATES, body),
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
    /** Bounded, searchable task page; `search` is the already-encoded query string. */
    taskPage: (s: Session, seg: string, search: string) =>
      call<{ tasks: TaskSummary[]; nextCursor: string | null }>(s, seg, 'GET', `/tasks?${search}`),
    resultPage: (s: Session, seg: string, search: string) =>
      call<{ results: ResultEntry[]; nextCursor: string | null }>(
        s,
        seg,
        'GET',
        `/results?${search}`,
      ),
    inboxPage: (s: Session, seg: string, search: string) =>
      call<{ items: InboxItem[]; nextCursor: string | null }>(s, seg, 'GET', `/inbox?${search}`),
    markRead: (s: Session, seg: string, conversationId: string, upToMessageId: string) =>
      call<{ read: unknown }>(s, seg, 'POST', `/conversations/${conversationId}/read`, {
        upToMessageId,
      }),
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
    /** One kind's listings; `admin` says whether the member may change connectors, nothing more. */
    async marketplace(
      s: Session,
      seg: string,
      kind: MarketplaceKind,
    ): Promise<ApiResult<{ listings: MarketplaceListing[]; admin: boolean }>> {
      const result = await call<{ listings: unknown; admin?: unknown }>(
        s,
        seg,
        'GET',
        `/marketplace?kind=${kind}`,
      );
      if (!result.ok) return result;
      const parsed = marketplaceListingSchema.array().safeParse(result.value.listings);
      return parsed.success
        ? { ok: true, value: { listings: parsed.data, admin: result.value.admin === true } }
        : { ok: false, status: 502, error: 'bad_contract' };
    },
    async marketplaceItem(
      s: Session,
      seg: string,
      kind: MarketplaceKind,
      id: string,
    ): Promise<ApiResult<MarketplaceDetail>> {
      const result = await call<{ item: unknown }>(
        s,
        seg,
        'GET',
        `/marketplace/${kind}/${encodeURIComponent(id)}`,
      );
      if (!result.ok) return result;
      const parsed = marketplaceDetailSchema.safeParse(result.value.item);
      return parsed.success
        ? { ok: true, value: parsed.data }
        : { ok: false, status: 502, error: 'bad_contract' };
    },
    connectorAction: (s: Session, seg: string, id: string, body: unknown) =>
      call<{ installation: InstallationView }>(
        s,
        seg,
        'POST',
        `/marketplace/connectors/${encodeURIComponent(id)}`,
        body,
      ),
    /** Status projection of the task graph; the segment omits nodes the member may not see. */
    graph: (s: Session, seg: string, id: string) =>
      call<{ projection: unknown; taskVersion: number }>(s, seg, 'GET', `/tasks/${id}/graph`),
    graphCommand: (
      s: Session,
      seg: string,
      id: string,
      action: 'cancel' | 'approve',
      body: unknown,
    ) =>
      call<{ projection: unknown; taskVersion: number }>(
        s,
        seg,
        'POST',
        `/tasks/${id}/graph/${action}`,
        body,
      ),
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
    /** One member file's metadata and preview, as the segment sends it. */
    attachment: (s: Session, seg: string, id: string) =>
      call<unknown>(s, seg, 'GET', `/attachments/${id}`),
    uploadAttachment: (s: Session, seg: string, conversationId: string, body: unknown) =>
      call<{ attachment: AttachmentView }>(
        s,
        seg,
        'POST',
        `/conversations/${conversationId}/attachments`,
        body,
      ),
    removeAttachment: (s: Session, seg: string, id: string) =>
      call<{ removed: boolean }>(s, seg, 'POST', `/attachments/${id}/remove`),
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
