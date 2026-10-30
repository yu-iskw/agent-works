import { readFileSync } from 'node:fs';

import { applyMigration } from '../db.js';

import type postgres from 'postgres';

/** 0018 extends the workbench tables for M1 teamwork; P0 reads its rows through the defaults. */
const migrations = [
  '0017_workbench.sql',
  '0018_teamwork.sql',
  '0019_teamwork_dependencies.sql',
] as const;

/** Idempotent: applied once under an advisory lock, recorded in schema_migrations. */
export async function applyWorkbenchMigration(sql: postgres.Sql): Promise<void> {
  await sql.begin(async (tx) => {
    await tx`select pg_advisory_xact_lock(7017)`;
    await tx`create table if not exists schema_migrations (
      name text primary key,
      applied_at timestamptz not null default now()
    )`;
    for (const migration of migrations) {
      // Static repository migration path, never request controlled.
      // eslint-disable-next-line security/detect-non-literal-fs-filename
      const body = readFileSync(new URL(`../../migrations/${migration}`, import.meta.url), 'utf8');
      await applyMigration(tx, migration, body);
    }
  });
}
