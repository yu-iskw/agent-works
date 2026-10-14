import { workspaceScopes } from '@agent-works/domain/workspace-tools';

import { ConnectorError } from './errors.js';

import type { CallerCredential } from './google-http.js';
import type { OAuthProvider } from '../credentials/provider.js';
import type { CredentialsPort } from '../ports/credentials.js';
import type { OAuthConnection } from '@agent-works/domain';
import type { WorkspaceToolName } from '@agent-works/domain/workspace-tools';
export type CredentialDeps = {
  readonly credentials: CredentialsPort;
  readonly provider: OAuthProvider;
  readonly resolveToken: (tokenRef: string, subject: string) => Promise<string | undefined>;
  readonly now: () => Date;
  readonly audit: (event: {
    subject: string;
    type: 'oauth.blocked';
    code: string;
    tool: string;
  }) => Promise<void>;
};
function scopesOf(value: string): readonly string[] {
  return [...new Set(value.split(/\s+/).filter(Boolean))].sort();
}
function hasWorkspaceScope(scopes: readonly string[], tool: WorkspaceToolName): boolean {
  const required = new Map(Object.entries(workspaceScopes)).get(tool);
  if (!required) return false;
  return (
    scopes.includes(required) ||
    (tool === 'calendar.listEvents' && scopes.includes(workspaceScopes['calendar.createEvent']))
  );
}
export function createWorkspaceCredentials(deps: CredentialDeps) {
  return {
    async forTool(subject: string, tool: WorkspaceToolName): Promise<CallerCredential> {
      const stored = await deps.credentials.read(subject, 'google');
      if (!stored || stored.subject !== subject || stored.provider !== 'google')
        throw new ConnectorError('AUTH_REQUIRED', 401);
      if (stored.status !== 'active' || Date.parse(stored.expiresAt) <= deps.now().getTime())
        return blocked(deps, subject, tool);
      let remote;
      try {
        remote = await deps.provider.read(stored.tokenRef);
      } catch {
        return blocked(deps, subject, tool);
      }
      if (!remoteValid(remote, stored, subject, deps.now())) return blocked(deps, subject, tool);
      const scopes = scopesOf(stored.scope).filter((scope) =>
        scopesOf(remote.scope).includes(scope),
      );
      if (!hasWorkspaceScope(scopes, tool)) throw new ConnectorError('STEP_UP_REQUIRED', 409);
      const token = await deps.resolveToken(stored.tokenRef, subject);
      if (!token) return blocked(deps, subject, tool);
      return { subject, token, scopes };
    },
  };
}
async function blocked(
  deps: CredentialDeps,
  subject: string,
  tool: WorkspaceToolName,
): Promise<never> {
  await deps.audit({ subject, type: 'oauth.blocked', code: 'AUTH_REVOKED', tool });
  throw new ConnectorError('AUTH_REVOKED', 401);
}
export type WorkspaceCredentials = ReturnType<typeof createWorkspaceCredentials>;

function remoteValid(
  remote: OAuthConnection,
  stored: OAuthConnection,
  subject: string,
  now: Date,
): boolean {
  return (
    remote.subject === subject &&
    remote.provider === 'google' &&
    remote.tokenRef === stored.tokenRef &&
    remote.status === 'active' &&
    Date.parse(remote.expiresAt) > now.getTime()
  );
}
