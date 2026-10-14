import { readFileSync } from 'node:fs';

import { currentPostgresTransaction } from '../ports/postgres-transaction.js';

import type postgres from 'postgres';

const name = '0016_user_memory.sql';
const ready = new WeakMap<postgres.Sql, Promise<void>>();
// eslint-disable-next-line security/detect-non-literal-fs-filename -- fixed bundled migration
const body = readFileSync(
  new URL('../../migrations/0016_user_memory.sql', import.meta.url),
  'utf8',
);
export function userMemoryReady(sql: postgres.Sql): Promise<void> {
  const tx = currentPostgresTransaction(sql);
  // DDL inside an outer transaction may roll back; never cache it as committed.
  if (tx !== undefined) return migrate(tx);
  const previous = ready.get(sql);
  if (previous !== undefined) return previous;
  const result = sql.begin(migrate).then(() => undefined);
  ready.set(sql, result);
  void result.catch(() => ready.delete(sql));
  return result;
}

async function migrate(tx: postgres.TransactionSql): Promise<void> {
  await tx`select pg_advisory_xact_lock(7016)`;
  await tx`create table if not exists schema_migrations (name text primary key, applied_at timestamptz not null default now())`;
  const applied = await tx`select name from schema_migrations where name = ${name}`;
  if (applied.length === 0) {
    await tx.unsafe(body);
    await tx`insert into schema_migrations (name) values (${name})`;
  }
}
