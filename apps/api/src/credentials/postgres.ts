import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { oauthConnectionSchema } from '@agent-works/domain';

import type { GrantStore, OAuthGrant } from './grant.js';
import type { CredentialsPort } from '../ports/credentials.js';
import type { OAuthConnection } from '@agent-works/domain';
import type postgres from 'postgres';

const migrationName = '0005_credentials.sql';
const migrationLock = 7005;
const migrationPath = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '../../migrations/0005_credentials.sql',
);

const migrations = new WeakMap<postgres.Sql, Promise<void>>();

type ConnectionRow = {
  provider: string;
  subject: string;
  scope: string;
  status: string;
  expires_at: Date;
  token_ref: string;
};

type GrantRow = {
  provider: string;
  subject: string;
  state: string;
  code_challenge: string;
  scope: string;
};

export type CredentialStore = {
  readonly credentials: CredentialsPort;
  readonly grants: GrantStore;
};

export async function applyCredentialsMigration(sql: postgres.Sql): Promise<void> {
  const body = readFileSync(migrationPath, 'utf8');
  await sql.begin(async (tx) => {
    await tx`select pg_advisory_xact_lock(${migrationLock})`;
    await tx`create table if not exists schema_migrations (
      name text primary key,
      applied_at timestamptz not null default now()
    )`;
    const applied = await tx<{ name: string }[]>`
      select name from schema_migrations where name = ${migrationName}
    `;
    if (applied.length > 0) return;
    await tx.unsafe(body);
    await tx`insert into schema_migrations (name) values (${migrationName})`;
  });
}

export function createPostgresCredentialStore(sql: postgres.Sql): CredentialStore {
  const ready = ensureMigration(sql);
  return {
    credentials: {
      save(connection) {
        return ready.then(() => upsertConnection(sql, connection));
      },
      read(subject, provider) {
        return ready.then(() => selectConnection(sql, subject, provider));
      },
    },
    grants: {
      save(grant) {
        return ready.then(() => upsertGrant(sql, grant));
      },
      read(state) {
        return ready.then(() => selectGrant(sql, state));
      },
      consume(state) {
        return ready.then(() => consumeGrant(sql, state));
      },
    },
  };
}

function ensureMigration(sql: postgres.Sql): Promise<void> {
  const existing = migrations.get(sql);
  if (existing !== undefined) return existing;
  const pending = applyCredentialsMigration(sql);
  migrations.set(sql, pending);
  return pending;
}

async function upsertConnection(
  sql: postgres.Sql,
  connection: OAuthConnection,
): Promise<OAuthConnection> {
  const parsed = oauthConnectionSchema.parse(connection);
  await sql`
    insert into oauth_connections (subject, provider, scope, status, expires_at, token_ref)
    values (
      ${parsed.subject}, ${parsed.provider}, ${parsed.scope}, ${parsed.status},
      ${parsed.expiresAt}, ${parsed.tokenRef}
    )
    on conflict (subject, provider) do update
    set scope = excluded.scope,
        status = excluded.status,
        expires_at = excluded.expires_at,
        token_ref = excluded.token_ref
  `;
  return parsed;
}

async function selectConnection(
  sql: postgres.Sql,
  subject: string,
  provider: string,
): Promise<OAuthConnection | undefined> {
  const rows = await sql<ConnectionRow[]>`
    select provider, subject, scope, status, expires_at, token_ref
    from oauth_connections
    where subject = ${subject} and provider = ${provider}
  `;
  if (rows.length === 0) return undefined;
  const row = rows[0];
  return oauthConnectionSchema.parse({
    provider: row.provider,
    subject: row.subject,
    scope: row.scope,
    status: row.status,
    expiresAt: row.expires_at.toISOString(),
    tokenRef: row.token_ref,
  });
}

async function upsertGrant(sql: postgres.Sql, grant: OAuthGrant): Promise<void> {
  await sql`
    insert into oauth_grants (state, provider, subject, code_challenge, scope)
    values (
      ${grant.state}, ${grant.provider}, ${grant.subject}, ${grant.codeChallenge}, ${grant.scope}
    )
    on conflict (state) do update
    set provider = excluded.provider,
        subject = excluded.subject,
        code_challenge = excluded.code_challenge,
        scope = excluded.scope
  `;
}

async function selectGrant(sql: postgres.Sql, state: string): Promise<OAuthGrant | undefined> {
  const rows = await sql<GrantRow[]>`
    select provider, subject, state, code_challenge, scope
    from oauth_grants
    where state = ${state}
  `;
  return toGrant(rows[0]);
}

async function consumeGrant(sql: postgres.Sql, state: string): Promise<OAuthGrant | undefined> {
  const rows = await sql<GrantRow[]>`
    delete from oauth_grants
    where state = ${state}
    returning provider, subject, state, code_challenge, scope
  `;
  return toGrant(rows[0]);
}

function toGrant(row: GrantRow | undefined): OAuthGrant | undefined {
  if (row === undefined) return undefined;
  return {
    provider: row.provider,
    subject: row.subject,
    state: row.state,
    codeChallenge: row.code_challenge,
    scope: row.scope,
  };
}
