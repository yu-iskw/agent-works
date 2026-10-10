import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import postgres from 'postgres';

const lockId = 7001;
const auditMigrationName = '0001_audit.sql';
const auditMigrationPath = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '../migrations/0001_audit.sql',
);

export async function openDatabase(url: string): Promise<postgres.Sql> {
  const sql = postgres(url);
  const auditMigration = readFileSync(auditMigrationPath, 'utf8');
  await sql.begin(async (tx) => {
    await tx`select pg_advisory_xact_lock(${lockId})`;
    await tx`create table if not exists schema_migrations (
      name text primary key,
      applied_at timestamptz not null default now()
    )`;
    const applied = await tx<{ name: string }[]>`
      select name from schema_migrations where name = ${auditMigrationName}
    `;
    if (applied.length > 0) return;
    await tx.unsafe(auditMigration);
    await tx`insert into schema_migrations (name) values (${auditMigrationName})`;
  });
  return sql;
}
