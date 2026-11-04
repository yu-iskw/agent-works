import { readFileSync } from 'node:fs';

import { applyMigration } from '../../db.js';

import type postgres from 'postgres';

export async function applySkillPackagesMigration(sql: postgres.Sql): Promise<void> {
  const name = '0032_skill_packages.sql';
  const body = readFileSync(new URL(`../../../migrations/${name}`, import.meta.url), 'utf8');
  await sql.begin(async (tx) => {
    await tx`select pg_advisory_xact_lock(7017)`;
    await tx`create table if not exists schema_migrations (name text primary key, applied_at timestamptz not null default now())`;
    await applyMigration(tx, name, body);
  });
}
