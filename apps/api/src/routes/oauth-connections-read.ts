import { IAP_ASSERTION_HEADER, oauthConnectionsSchema } from '@agent-works/domain';

import { Unauthenticated, Unavailable } from '../auth/iap.js';
import { applyCredentialsMigration } from '../credentials/postgres.js';
import { headerValue } from '../http.js';

import type { VerifyAssertion } from '../auth/iap.js';
import type { Route } from '../http.js';
import type postgres from 'postgres';
import type { z } from 'zod';

type ConnectionSummary = z.infer<typeof oauthConnectionsSchema>['connections'][number];

export type OAuthConnectionsReadDeps = {
  readonly verify: VerifyAssertion;
  readonly read: (subject: string) => Promise<readonly ConnectionSummary[]>;
  readonly now: () => Date;
};

export function createOAuthConnectionsReadRoute(deps: OAuthConnectionsReadDeps): Route {
  return async (request) => {
    try {
      const caller = await deps.verify(headerValue(request.headers, IAP_ASSERTION_HEADER));
      if (caller.sub.length === 0) throw new Unauthenticated('bad_claims');
      const connections = await deps.read(caller.sub);
      const now = deps.now().getTime();
      return {
        status: 200,
        body: oauthConnectionsSchema.parse({
          kind: 'connections',
          connections: connections.map((connection) => ({
            provider: connection.provider,
            scope: connection.scope,
            status:
              connection.status === 'active' && Date.parse(connection.expiresAt) <= now
                ? 'expired'
                : connection.status,
            expiresAt: connection.expiresAt,
          })),
        }),
      };
    } catch (error) {
      if (error instanceof Unauthenticated)
        return { status: 401, body: { error: 'unauthenticated' } };
      if (error instanceof Unavailable) return { status: 503, body: { error: 'unavailable' } };
      throw error;
    }
  };
}

export function createPostgresOAuthConnectionsReader(
  sql: postgres.Sql,
): OAuthConnectionsReadDeps['read'] {
  let ready: Promise<void> | undefined;
  return async (subject) => {
    ready ??= applyCredentialsMigration(sql);
    await ready;
    const rows = await sql<
      { provider: string; scope: string; status: ConnectionSummary['status']; expires_at: Date }[]
    >`
      select provider, scope, status, expires_at
      from oauth_connections
      where subject = ${subject}
      order by provider
    `;
    return rows.map((row) => ({
      provider: row.provider,
      scope: row.scope,
      status: row.status,
      expiresAt: row.expires_at.toISOString(),
    }));
  };
}
