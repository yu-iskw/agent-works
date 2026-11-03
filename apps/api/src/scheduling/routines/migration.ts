import { readFileSync } from 'node:fs';

import { applyMigration } from '../../db.js';

import type postgres from 'postgres';

/** Opt-in runner for 0030; the segment applies 0024 first. */
export async function applyRoutineMigration(sql: postgres.Sql): Promise<void> {
  await sql.begin(async (tx) => {
    await tx`select pg_advisory_xact_lock(7030)`;
    await tx`create table if not exists schema_migrations (
      name text primary key,
      applied_at timestamptz not null default now()
    )`;
    // Static repository migration path, never request controlled.
    // eslint-disable-next-line security/detect-non-literal-fs-filename
    const body = readFileSync(
      new URL('../../../migrations/0030_routines.sql', import.meta.url),
      'utf8',
    );
    await applyMigration(tx, '0030_routines.sql', body);
  });
}
