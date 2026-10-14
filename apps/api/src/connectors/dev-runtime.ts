import { randomUUID } from 'node:crypto';

import { outboxEventSchema, searchContextSchema } from '@agent-works/domain';

import { createPostgresApprovalStore } from '../broker/approvals.js';
import { createPostgresCredentialStore } from '../credentials/postgres.js';
import { createHttpOAuthProvider } from '../credentials/provider.js';

import { ConnectorError } from './errors.js';
import { createWorkspaceRuntime } from './runtime.js';
import { classifySources } from './source-data.js';

import type { WorkspaceCall } from './broker.js';
import type { AgentRunner } from '../agent/runner-port.js';
import type { AppRole } from '../auth/directory.js';
import type { VerifyAssertion } from '../auth/iap.js';
import type { OAuthFlow } from '../credentials/flow.js';
import type { LedgerPort } from '../ports/ledger-port.js';
import type { createHttpDrive } from '../retrieval/http-drive.js';
import type { SkillRegistry } from '../skills/registry.js';
import type { SuspensionEnforcer } from '../suspension/enforcement.js';
import type postgres from 'postgres';

type DevWorkspaceDeps = {
  readonly sql: postgres.Sql;
  readonly baseUrl: string;
  readonly redirectUri: string;
  readonly flow: OAuthFlow;
  readonly verify: VerifyAssertion;
  readonly groups: (sub: string) => Promise<{ readonly groups: readonly string[] }>;
  readonly rolesFor: (sub: string) => Promise<readonly AppRole[]>;
  readonly ledger: LedgerPort;
  readonly skills: () => SkillRegistry;
  readonly enforcement: SuspensionEnforcer;
  readonly drive: ReturnType<typeof createHttpDrive>;
  readonly runner: AgentRunner;
  readonly now: () => Date;
};

/** Explicit opt-in for the offline Compose stack; never resolves production tokens. */
export function createDevWorkspaceRuntime(deps: DevWorkspaceDeps) {
  const approvers = new Set<string>();
  async function refreshApprover(subject: string) {
    approvers.delete(subject);
    const roles = await deps.rolesFor(subject);
    if (roles.includes('Reviewer') || roles.includes('Admin')) approvers.add(subject);
    return roles;
  }
  const approvals = createPostgresApprovalStore(deps.sql);
  async function allowed(subject: string, taskId: string, tool: string) {
    const roles = await refreshApprover(subject);
    const task = await deps.ledger.read(subject, taskId);
    const skill = task === undefined ? undefined : deps.skills().get(task.skillVersion);
    if (
      !roles.includes('Employee') ||
      !task ||
      !skill ||
      skill.manifest.state !== 'PUBLISHED' ||
      !skill.manifest.tools.includes(tool) ||
      ['COMPLETED', 'CANCELLED', 'BLOCKED_AUTH', 'FAILED', 'PAUSED'].includes(task.status)
    )
      return false;
    const rows = await deps.sql<{ context: unknown }[]>`
      select payload->'context' as context from task_deliveries where task_id = ${taskId}
    `;
    const context = searchContextSchema.safeParse(rows.at(0)?.context);
    if (
      !context.success ||
      context.data.userSubject !== subject ||
      (task.skillVersion === 'workspace-task' &&
        !context.data.allowedSources.includes(tool.split('.')[0]))
    )
      return false;
    await deps.enforcement.check(
      {
        subject,
        teams: (await deps.groups(subject)).groups,
        agent: { kind: 'agent', id: 'api', version: '1' },
        skill: { kind: 'skill', id: skill.manifest.id, version: skill.manifest.version },
        tool: { kind: 'tool', id: tool, version: '1.0.0' },
        model: 'gemini',
        taskId,
        traceId: taskId,
      },
      'tool',
    );
    return true;
  }
  const endpoint = { baseUrl: deps.baseUrl, allowedHosts: ['fake-workspace'] };
  return createWorkspaceRuntime({
    endpoints: { docs: endpoint, calendar: endpoint, gmail: endpoint },
    credentials: {
      ...createPostgresCredentialStore(deps.sql),
      provider: createHttpOAuthProvider(deps.baseUrl, deps.redirectUri),
      resolveToken: (tokenRef) => Promise.resolve(tokenRef),
      now: deps.now,
      audit: async (event) => {
        await audit(event.type, event.subject, 'oauth', event.tool, null);
      },
    },
    broker: {
      approvals,
      now: deps.now,
      approverAuthorized: (subject) => approvers.has(subject),
      authorize: async (input: WorkspaceCall) => {
        if (input.approvalId) {
          const approval = await approvals.read(input.approvalId);
          if (approval?.approverSub) await refreshApprover(approval.approverSub);
        }
        return {
          allowed: await allowed(input.subject, input.taskId, input.tool),
          ceiling: 'INTERNAL',
          decisionId: randomUUID(),
        };
      },
      audit: async (event) => {
        await audit(
          event.type,
          event.subject,
          event.callId,
          event.tool,
          event.payloadSha256 ?? null,
        );
      },
    },
    routes: {
      flow: deps.flow,
      verify: async (assertion) => {
        const caller = await deps.verify(assertion);
        await refreshApprover(caller.sub);
        return caller;
      },
      authorizePreparation: allowed,
    },
    meeting: {
      driveSearch: async (query, authorized, taskId) => {
        if (!(await allowed(authorized.caller.sub, taskId, 'drive.search')))
          throw new ConnectorError('POLICY_DENIED', 403);
        const scope = await deps.drive.openWorker(authorized.caller.sub);
        const rows = await scope.port.search(authorized.context, query);
        return classifySources(
          rows.map((row) => ({
            id: row.sourceObjectId,
            title: row.title,
            body: row.text,
            classification: 'INTERNAL',
          })),
          'INTERNAL',
          false,
        );
      },
      draft: async (input) =>
        (
          await deps.runner.run({
            question: input.question,
            sources: input.sources.map((source) => ({
              id: source.id,
              title: source.title,
              text: source.body,
              uri: `https://sources.invalid/${encodeURIComponent(source.id)}`,
            })),
          })
        ).answer,
    },
  });
  async function audit(
    type: string,
    subject: string,
    callId: string,
    tool: string,
    digest: string | null,
  ) {
    await deps.ledger.append(
      outboxEventSchema.parse({
        destination: 'audit',
        event: {
          eventId: randomUUID(),
          eventType: type,
          schemaVersion: '1',
          occurredAt: deps.now().toISOString(),
          taskId: callId,
          stepId: 'workspace',
          traceId: callId,
          initiatorSubject: subject,
          agentPrincipal: 'agent:api',
          tool,
          policyDecisionId: null,
          approvalId: null,
          requestDigestSha256: digest,
          outcome: type.endsWith('denied') || type === 'oauth.blocked' ? 'DENIED' : 'ALLOWED',
          externalObjectRef: null,
          prevDigest: null,
        },
      }),
    );
  }
}
