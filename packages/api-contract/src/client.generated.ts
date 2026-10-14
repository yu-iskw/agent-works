// Generated from openapi.json. Run pnpm api:generate; do not edit.
import { ContractTransport } from './transport.js';
import type { ClientOptions } from './transport.js';
export type AskRequest = { readonly requestId: string; readonly question: string };
export type AskResponse = {
  readonly requestId: string;
  readonly answer: string;
  readonly citations: readonly {
    readonly sourceObjectId: string;
    readonly title: string;
    readonly sourceUri: string;
    readonly retrievedAt: string;
    readonly excerpt: string;
  }[];
};
export type TaskSubmit = {
  readonly kind: 'submit';
  readonly objective: string;
  readonly skillId: string;
  readonly input?: { readonly [key: string]: JsonValue };
  readonly sourceAllowlist: readonly string[];
  readonly requestedOutputs: readonly string[];
  readonly executionPolicy: {
    readonly mode: string;
    readonly budgetUsd: number;
    readonly deadlineSeconds: number;
  };
};
export type TaskAccepted = {
  readonly kind: 'accepted';
  readonly taskId: string;
  readonly status:
    | 'CREATED'
    | 'AUTHORIZED'
    | 'QUEUED'
    | 'RUNNING'
    | 'COMPLETED'
    | 'WAITING_APPROVAL'
    | 'WAITING_INPUT'
    | 'BLOCKED_AUTH'
    | 'PAUSED'
    | 'RETRYING'
    | 'FAILED'
    | 'CANCELLED';
  readonly submittedAt: string;
  readonly statusUrl: string;
  readonly traceId: string;
};
export type Task = {
  readonly id: string;
  readonly createdBySub: string;
  readonly status:
    | 'CREATED'
    | 'AUTHORIZED'
    | 'QUEUED'
    | 'RUNNING'
    | 'COMPLETED'
    | 'WAITING_APPROVAL'
    | 'WAITING_INPUT'
    | 'BLOCKED_AUTH'
    | 'PAUSED'
    | 'RETRYING'
    | 'FAILED'
    | 'CANCELLED';
  readonly objectiveDigest: string;
  readonly skillVersion: string;
  readonly agentVersion: string;
  readonly policyVersion: string;
  readonly budget: number;
  readonly version: number;
  readonly createdAt: string;
  readonly updatedAt: string;
};
export type TaskEvents = {
  readonly events: readonly {
    readonly destination: 'audit' | 'work';
    readonly event: {
      readonly eventId: string;
      readonly eventType: string;
      readonly schemaVersion: string;
      readonly occurredAt: string;
      readonly taskId: string;
      readonly stepId: string;
      readonly traceId: string;
      readonly initiatorSubject: string;
      readonly agentPrincipal: string;
      readonly tool: string | null;
      readonly policyDecisionId: string | null;
      readonly approvalId: string | null;
      readonly requestDigestSha256: string | null;
      readonly outcome: string;
      readonly externalObjectRef: string | null;
      readonly prevDigest: string | null;
    };
  }[];
};
export type TaskCancelled = {
  readonly taskId: string;
  readonly status:
    | 'CREATED'
    | 'AUTHORIZED'
    | 'QUEUED'
    | 'RUNNING'
    | 'COMPLETED'
    | 'WAITING_APPROVAL'
    | 'WAITING_INPUT'
    | 'BLOCKED_AUTH'
    | 'PAUSED'
    | 'RETRYING'
    | 'FAILED'
    | 'CANCELLED';
};
export type ApprovalDetail = {
  readonly kind: 'detail';
  readonly id: string;
  readonly actionSummary: string;
  readonly requestedBySub: string;
  readonly payloadSha256: string;
  readonly state: string;
  readonly expiresAt: string;
};
export type ApprovalDecide = {
  readonly kind: 'decide';
  readonly decision: 'approve' | 'reject';
  readonly expectedPayloadSha256: string;
};
export type ApprovalDecided = {
  readonly kind: 'decided';
  readonly id: string;
  readonly state: 'approved' | 'rejected';
  readonly executionsUsed: number;
};
export type SkillList = {
  readonly skills: readonly {
    readonly id: string;
    readonly version: string;
    readonly tools: readonly string[];
    readonly state:
      | 'DRAFT'
      | 'SECURITY_REVIEW'
      | 'EVALUATED'
      | 'APPROVED'
      | 'PUBLISHED'
      | 'DEPRECATED'
      | 'REVOKED';
  }[];
};
export type OAuthConnections = {
  readonly kind: 'connections';
  readonly connections: readonly {
    readonly provider: string;
    readonly scope: string;
    readonly status: 'active' | 'revoked' | 'expired';
    readonly expiresAt: string;
  }[];
};
export type OAuthStart = {
  readonly kind: 'start';
  readonly provider: string;
  readonly state: string;
  readonly codeChallenge: string;
  readonly codeChallengeMethod: 'S256';
  readonly scope: string;
};
export type OAuthStarted = {
  readonly provider: string;
  readonly state: string;
  readonly codeChallenge: string;
  readonly codeChallengeMethod: 'S256';
  readonly scope: string;
  readonly authorizationUrl: string;
  readonly kind: 'started';
};
export type OAuthConnection = {
  readonly kind: 'connection';
  readonly provider: string;
  readonly subject: string;
  readonly scope: string;
  readonly status: 'active' | 'revoked' | 'expired';
  readonly expiresAt: string;
  readonly tokenRef: string;
};
export type OAuthConnectRequest =
  | {
      readonly kind: 'start';
      readonly provider: string;
      readonly state: string;
      readonly codeChallenge: string;
      readonly codeChallengeMethod: 'S256';
      readonly scope: string;
    }
  | {
      readonly kind: 'callback';
      readonly provider: string;
      readonly state: string;
      readonly code: string;
      readonly codeVerifier: string;
    };
export type OAuthConnectResponse =
  | {
      readonly provider: string;
      readonly state: string;
      readonly codeChallenge: string;
      readonly codeChallengeMethod: 'S256';
      readonly scope: string;
      readonly authorizationUrl: string;
      readonly kind: 'started';
    }
  | {
      readonly kind: 'connection';
      readonly provider: string;
      readonly subject: string;
      readonly scope: string;
      readonly status: 'active' | 'revoked' | 'expired';
      readonly expiresAt: string;
      readonly tokenRef: string;
    };
export type SuspensionCommand = {
  readonly commandId: string;
  readonly action: 'suspend' | 'resume';
  readonly target:
    | { readonly scope: 'global'; readonly id: '*'; readonly version: null }
    | { readonly scope: 'team'; readonly id: string; readonly version: null }
    | { readonly scope: 'user'; readonly id: string; readonly version: null }
    | { readonly scope: 'agent'; readonly id: string; readonly version: string | null }
    | { readonly scope: 'skill'; readonly id: string; readonly version: string | null }
    | { readonly scope: 'model'; readonly id: string; readonly version: null }
    | { readonly scope: 'tool'; readonly id: string; readonly version: string | null };
  readonly reason: string;
  readonly expiresAt: string | null;
  readonly expectedRevision: number;
};
export type CapabilityVersionCommand = {
  readonly commandId: string;
  readonly pin: {
    readonly kind: 'agent' | 'skill' | 'tool';
    readonly id: string;
    readonly version: string;
  };
  readonly state: 'draft' | 'published' | 'deprecated' | 'revoked';
  readonly reason: string;
  readonly expectedRevision: number;
};
export type SuspensionSnapshot = {
  readonly suspensions: readonly {
    readonly target:
      | { readonly scope: 'global'; readonly id: '*'; readonly version: null }
      | { readonly scope: 'team'; readonly id: string; readonly version: null }
      | { readonly scope: 'user'; readonly id: string; readonly version: null }
      | { readonly scope: 'agent'; readonly id: string; readonly version: string | null }
      | { readonly scope: 'skill'; readonly id: string; readonly version: string | null }
      | { readonly scope: 'model'; readonly id: string; readonly version: null }
      | { readonly scope: 'tool'; readonly id: string; readonly version: string | null };
    readonly suspended: boolean;
    readonly reason: string;
    readonly actorSub: string;
    readonly expiresAt: string | null;
    readonly revision: number;
    readonly occurredAt: string;
    readonly commandId: string;
  }[];
  readonly versions: readonly {
    readonly pin: {
      readonly kind: 'agent' | 'skill' | 'tool';
      readonly id: string;
      readonly version: string;
    };
    readonly state: 'draft' | 'published' | 'deprecated' | 'revoked';
    readonly reason: string;
    readonly actorSub: string;
    readonly revision: number;
    readonly occurredAt: string;
    readonly commandId: string;
  }[];
};
export type SuspensionHistory = {
  readonly events: readonly {
    readonly eventId: string;
    readonly eventType: 'admin.suspend' | 'admin.resume' | 'admin.version' | 'invocation.denied';
    readonly actorSub: string;
    readonly occurredAt: string;
    readonly reason: string;
    readonly digest: string;
    readonly taskId: string | null;
    readonly traceId: string;
    readonly details: JsonValue;
  }[];
};
export type SuspensionResult = {
  readonly record:
    | {
        readonly target:
          | { readonly scope: 'global'; readonly id: '*'; readonly version: null }
          | { readonly scope: 'team'; readonly id: string; readonly version: null }
          | { readonly scope: 'user'; readonly id: string; readonly version: null }
          | { readonly scope: 'agent'; readonly id: string; readonly version: string | null }
          | { readonly scope: 'skill'; readonly id: string; readonly version: string | null }
          | { readonly scope: 'model'; readonly id: string; readonly version: null }
          | { readonly scope: 'tool'; readonly id: string; readonly version: string | null };
        readonly suspended: boolean;
        readonly reason: string;
        readonly actorSub: string;
        readonly expiresAt: string | null;
        readonly revision: number;
        readonly occurredAt: string;
        readonly commandId: string;
      }
    | {
        readonly pin: {
          readonly kind: 'agent' | 'skill' | 'tool';
          readonly id: string;
          readonly version: string;
        };
        readonly state: 'draft' | 'published' | 'deprecated' | 'revoked';
        readonly reason: string;
        readonly actorSub: string;
        readonly revision: number;
        readonly occurredAt: string;
        readonly commandId: string;
      };
  readonly replay: boolean;
};
export type Error = { readonly error: string };
export type JsonValue =
  string | number | boolean | null | readonly JsonValue[] | { readonly [key: string]: JsonValue };
export class ApiClient {
  private readonly transport: ContractTransport;
  constructor(options: ClientOptions) {
    this.transport = new ContractTransport(options);
  }
  ask(body: AskRequest, headers: Readonly<Record<string, string>> = {}): Promise<AskResponse> {
    return this.transport.request<AskResponse>('ask', 'POST', `/v1/ask`, body, headers);
  }
  submitTask(
    body: TaskSubmit,
    headers: Readonly<Record<string, string>> = {},
  ): Promise<TaskAccepted> {
    return this.transport.request<TaskAccepted>('submitTask', 'POST', `/v1/tasks`, body, headers);
  }
  readTask(taskId: string, headers: Readonly<Record<string, string>> = {}): Promise<Task> {
    return this.transport.request<Task>(
      'readTask',
      'GET',
      `/v1/tasks/${encodeURIComponent(taskId)}`,
      undefined,
      headers,
    );
  }
  taskEvents(taskId: string, headers: Readonly<Record<string, string>> = {}): Promise<TaskEvents> {
    return this.transport.request<TaskEvents>(
      'taskEvents',
      'GET',
      `/v1/tasks/${encodeURIComponent(taskId)}/events`,
      undefined,
      headers,
    );
  }
  cancelTask(
    taskId: string,
    headers: Readonly<Record<string, string>> = {},
  ): Promise<TaskCancelled> {
    return this.transport.request<TaskCancelled>(
      'cancelTask',
      'POST',
      `/v1/tasks/${encodeURIComponent(taskId)}:cancel`,
      undefined,
      headers,
    );
  }
  readApproval(
    id: string,
    headers: Readonly<Record<string, string>> = {},
  ): Promise<ApprovalDetail> {
    return this.transport.request<ApprovalDetail>(
      'readApproval',
      'GET',
      `/v1/approvals/${encodeURIComponent(id)}`,
      undefined,
      headers,
    );
  }
  decideApproval(
    id: string,
    body: ApprovalDecide,
    headers: Readonly<Record<string, string>> = {},
  ): Promise<ApprovalDecided> {
    return this.transport.request<ApprovalDecided>(
      'decideApproval',
      'POST',
      `/v1/approvals/${encodeURIComponent(id)}:decide`,
      body,
      headers,
    );
  }
  listSkills(headers: Readonly<Record<string, string>> = {}): Promise<SkillList> {
    return this.transport.request<SkillList>('listSkills', 'GET', `/v1/skills`, undefined, headers);
  }
  listConnections(headers: Readonly<Record<string, string>> = {}): Promise<OAuthConnections> {
    return this.transport.request<OAuthConnections>(
      'listConnections',
      'GET',
      `/v1/oauth/connections`,
      undefined,
      headers,
    );
  }
  connectOAuth(
    provider: string,
    body: OAuthConnectRequest,
    headers: Readonly<Record<string, string>> = {},
  ): Promise<OAuthConnectResponse> {
    return this.transport.request<OAuthConnectResponse>(
      'connectOAuth',
      'POST',
      `/v1/oauth/connections/${encodeURIComponent(provider)}`,
      body,
      headers,
    );
  }
  revokeOAuth(
    provider: string,
    headers: Readonly<Record<string, string>> = {},
  ): Promise<OAuthConnection> {
    return this.transport.request<OAuthConnection>(
      'revokeOAuth',
      'DELETE',
      `/v1/oauth/connections/${encodeURIComponent(provider)}`,
      undefined,
      headers,
    );
  }
  adminSnapshot(headers: Readonly<Record<string, string>> = {}): Promise<SuspensionSnapshot> {
    return this.transport.request<SuspensionSnapshot>(
      'adminSnapshot',
      'GET',
      `/v1/admin/suspensions`,
      undefined,
      headers,
    );
  }
  changeSuspension(
    body: SuspensionCommand,
    headers: Readonly<Record<string, string>> = {},
  ): Promise<SuspensionResult> {
    return this.transport.request<SuspensionResult>(
      'changeSuspension',
      'POST',
      `/v1/admin/suspensions`,
      body,
      headers,
    );
  }
  adminHistory(headers: Readonly<Record<string, string>> = {}): Promise<SuspensionHistory> {
    return this.transport.request<SuspensionHistory>(
      'adminHistory',
      'GET',
      `/v1/admin/history`,
      undefined,
      headers,
    );
  }
  changeVersion(
    body: CapabilityVersionCommand,
    headers: Readonly<Record<string, string>> = {},
  ): Promise<SuspensionResult> {
    return this.transport.request<SuspensionResult>(
      'changeVersion',
      'POST',
      `/v1/admin/versions`,
      body,
      headers,
    );
  }
}
