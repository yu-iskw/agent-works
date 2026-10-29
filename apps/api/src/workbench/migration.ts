import { readFileSync } from 'node:fs';

import { applyMigration } from '../db.js';

import type postgres from 'postgres';

const migration = '0017_workbench.sql';

/** Idempotent: applied once under an advisory lock, recorded in schema_migrations. */
export async function applyWorkbenchMigration(sql: postgres.Sql): Promise<void> {
  // Static repository migration path, never request controlled.
  // eslint-disable-next-line security/detect-non-literal-fs-filename
  const body = readFileSync(new URL(`../../migrations/${migration}`, import.meta.url), 'utf8');
  await sql.begin(async (tx) => {
    await tx`select pg_advisory_xact_lock(7017)`;
    await tx`create table if not exists schema_migrations (
      name text primary key,
      applied_at timestamptz not null default now()
    )`;
    await applyMigration(tx, migration, body);
  });
}
