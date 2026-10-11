import { afterAll, beforeAll, expect, it } from 'vitest';

import { openSql, startDisposablePostgres } from '../ledger/disposable-postgres.js';
import { credentialsPortContract } from '../ports/credentials.contract.js';

import { applyCredentialsMigration, createPostgresCredentialStore } from './postgres.js';

import type { DisposablePostgres } from '../ledger/disposable-postgres.js';
import type { Sql } from 'postgres';

let database: DisposablePostgres | undefined;
let sql: Sql | undefined;

beforeAll(async () => {
  database = await startDisposablePostgres();
  sql = openSql(database.url);
  await applyCredentialsMigration(sql);
}, 60_000);

afterAll(async () => {
  await sql?.end({ timeout: 1 });
  await database?.stop();
});

credentialsPortContract(() => {
  if (sql === undefined) throw new Error('postgres');
  return createPostgresCredentialStore(sql).credentials;
});

it('a second pool reads the grant saved by the first', async () => {
  if (database === undefined || sql === undefined) throw new Error('postgres');
  const grant = {
    provider: 'fake',
    subject: 'alice',
    state: 'state-9',
    codeChallenge: 'challenge',
    scope: 'ticket.create',
  };
  const writer = createPostgresCredentialStore(sql);
  await writer.grants.save(grant);
  const second = openSql(database.url);
  try {
    const reader = createPostgresCredentialStore(second);
    expect(await reader.grants.read('state-9')).toEqual(grant);
    expect(await reader.grants.consume('state-9')).toEqual(grant);
    expect(await writer.grants.read('state-9')).toBeUndefined();
  } finally {
    await second.end({ timeout: 1 });
  }
});

it('oauth_connections has no raw token column', async () => {
  if (sql === undefined) throw new Error('postgres');
  const rows = await sql<{ column_name: string }[]>`
    select column_name
    from information_schema.columns
    where table_schema = 'public' and table_name = 'oauth_connections'
    order by column_name
  `;
  expect(rows.map((row) => row.column_name)).toEqual([
    'expires_at',
    'provider',
    'scope',
    'status',
    'subject',
    'token_ref',
  ]);
});
