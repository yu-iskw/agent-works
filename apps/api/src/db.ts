import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import postgres from 'postgres';

const lockId = 7001;
const auditMigrationName = '0001_audit.sql';
const reservationMigrationName = '0002_ask_reservation.sql';
const auditMigrationPath = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '../migrations/0001_audit.sql',
);
const reservationMigrationPath = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '../migrations/0002_ask_reservation.sql',
);

export async function openDatabase(url: string): Promise<postgres.Sql> {
  const sql = postgres(url);
  const auditMigration = readFileSync(auditMigrationPath, 'utf8');
  const reservationMigration = readFileSync(reservationMigrationPath, 'utf8');
  await sql.begin(async (tx) => {
    await tx`select pg_advisory_xact_lock(${lockId})`;
    await tx`create table if not exists schema_migrations (
      name text primary key,
      applied_at timestamptz not null default now()
    )`;
    await applyMigration(tx, auditMigrationName, auditMigration);
    await applyMigration(tx, reservationMigrationName, reservationMigration);
  });
  return sql;
}

/** Runs `body` once per `name`, inside the caller's transaction, and records it. */
export async function applyMigration(
  tx: postgres.TransactionSql,
  name: string,
  body: string,
): Promise<void> {
  const applied = await tx<{ name: string }[]>`
    select name from schema_migrations where name = ${name}
  `;
  if (applied.length > 0) return;
  await tx.unsafe(body);
  await tx`insert into schema_migrations (name) values (${name})`;
}
