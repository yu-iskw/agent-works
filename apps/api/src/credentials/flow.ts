import { createHash } from 'node:crypto';

import { oauthConnectionSchema, outboxEventSchema } from '@agent-works/domain';

import { OAuthDenied, oauthFailure } from './denied.js';

import type { GrantStore, OAuthGrant } from './grant.js';
import type { OAuthProvider } from './provider.js';
import type { CredentialsPort } from '../ports/credentials.js';
import type {
  OAuthCallback,
  OAuthConnection,
  OAuthStart,
  OutboxEvent,
  Task,
  TaskStatus,
} from '@agent-works/domain';

export { OAuthDenied };

interface AuthLedger {
  read(subject: string, taskId: string): Promise<Task | undefined>;
  transition(input: {
    readonly subject: string;
    readonly taskId: string;
    readonly expectedVersion: number;
    readonly to: TaskStatus;
    readonly event: OutboxEvent;
  }): Promise<Task>;
}

export type OAuthFlow = {
  begin(subject: string, start: OAuthStart): Promise<OAuthStart>;
  complete(subject: string, callback: OAuthCallback): Promise<OAuthConnection>;
  revoke(subject: string, provider: string): Promise<OAuthConnection>;
  blockIfStale(subject: string, provider: string, taskId: string): Promise<Task>;
};

type OAuthFlowDeps = {
  readonly credentials: CredentialsPort;
  readonly grants: GrantStore;
  readonly provider: OAuthProvider;
  readonly ledger: AuthLedger;
  readonly now: () => Date;
};

const blocked = 'BLOCKED_AUTH';

export function createOAuthFlow(deps: OAuthFlowDeps): OAuthFlow {
  return {
    begin(subject, start) {
      return deps.grants
        .save({
          subject,
          provider: start.provider,
          state: start.state,
          codeChallenge: start.codeChallenge,
          scope: start.scope,
        })
        .then(() => start);
    },
    complete(subject, callback) {
      return complete(deps, subject, callback);
    },
    revoke(subject, provider) {
      return revoke(deps, subject, provider);
    },
    blockIfStale(subject, provider, taskId) {
      return blockIfStale(deps, subject, provider, taskId);
    },
  };
}

async function complete(
  deps: OAuthFlowDeps,
  subject: string,
  callback: OAuthCallback,
): Promise<OAuthConnection> {
  const grant = await deps.grants.read(callback.state);
  if (!ownedBy(grant, subject, callback.provider)) {
    throw new OAuthDenied(oauthFailure.stateMismatch);
  }
  if (grant.codeChallenge !== s256(callback.codeVerifier)) {
    throw new OAuthDenied(oauthFailure.pkceMismatch);
  }
  const taken = await deps.grants.consume(callback.state);
  if (taken === undefined) throw new OAuthDenied(oauthFailure.stateMismatch);
  const issued = await deps.provider.exchange(callback);
  if (issued.provider !== grant.provider || issued.subject !== grant.subject) {
    throw new OAuthDenied(oauthFailure.rejected);
  }
  return deps.credentials.save(connectionOf(issued));
}

async function revoke(
  deps: OAuthFlowDeps,
  subject: string,
  provider: string,
): Promise<OAuthConnection> {
  const stored = await deps.credentials.read(subject, provider);
  if (stored === undefined) throw new OAuthDenied(oauthFailure.missing);
  const remote = await deps.provider.revoke(stored.tokenRef);
  return deps.credentials.save(connectionOf({ ...remote, subject, provider, status: 'revoked' }));
}

async function blockIfStale(
  deps: OAuthFlowDeps,
  subject: string,
  provider: string,
  taskId: string,
): Promise<Task> {
  const stored = await deps.credentials.read(subject, provider);
  if (stored === undefined) throw new OAuthDenied(oauthFailure.missing);
  const remote = await deps.provider.read(stored.tokenRef);
  const status = combinedStatus(stored, remote, deps.now());
  const current =
    status === stored.status
      ? stored
      : await deps.credentials.save(connectionOf({ ...stored, status }));
  const task = await deps.ledger.read(subject, taskId);
  if (task === undefined) throw new OAuthDenied(oauthFailure.missing);
  if (current.status === 'active' || task.status !== 'RUNNING') return task;
  return deps.ledger.transition({
    subject,
    taskId,
    expectedVersion: task.version,
    to: blocked,
    event: blockedEvent(task, current, deps.now()),
  });
}

function combinedStatus(
  stored: OAuthConnection,
  remote: OAuthConnection,
  now: Date,
): OAuthConnection['status'] {
  if (stored.status === 'revoked' || remote.status === 'revoked') return 'revoked';
  const expired =
    stored.status === 'expired' ||
    remote.status === 'expired' ||
    Date.parse(stored.expiresAt) <= now.getTime() ||
    Date.parse(remote.expiresAt) <= now.getTime();
  return expired ? 'expired' : 'active';
}

function blockedEvent(task: Task, connection: OAuthConnection, now: Date): OutboxEvent {
  return outboxEventSchema.parse({
    destination: 'work',
    event: {
      eventId: `auth-${task.id}-${String(task.version)}`,
      eventType: 'oauth.blocked',
      schemaVersion: '1',
      occurredAt: now.toISOString(),
      taskId: task.id,
      stepId: 'oauth',
      traceId: task.id,
      initiatorSubject: task.createdBySub,
      agentPrincipal: 'credentials',
      tool: null,
      policyDecisionId: null,
      approvalId: null,
      requestDigestSha256: null,
      outcome: blocked,
      externalObjectRef: connection.tokenRef,
      prevDigest: null,
    },
  });
}

function connectionOf(connection: OAuthConnection): OAuthConnection {
  return oauthConnectionSchema.parse({
    provider: connection.provider,
    subject: connection.subject,
    scope: connection.scope,
    status: connection.status,
    expiresAt: connection.expiresAt,
    tokenRef: connection.tokenRef,
  });
}

function ownedBy(
  grant: OAuthGrant | undefined,
  subject: string,
  provider: string,
): grant is OAuthGrant {
  return grant !== undefined && grant.subject === subject && grant.provider === provider;
}

function s256(verifier: string): string {
  return createHash('sha256').update(verifier).digest('base64url');
}
