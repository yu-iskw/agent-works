import { readFileSync } from 'node:fs';

import type postgres from 'postgres';
const pending = new WeakMap<postgres.Sql, Promise<void>>();
export function analyticsReady(sql: postgres.Sql): Promise<void> {
  const cached = pending.get(sql);
  if (cached !== undefined) return cached;
  const applying = apply(sql).catch((error: unknown) => {
    pending.delete(sql);
    throw error;
  });
  pending.set(sql, applying);
  return applying;
}
async function apply(sql: postgres.Sql): Promise<void> {
  const name = '0015_analytics.sql';
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- fixed module-relative migration
  const body = readFileSync(
    new URL('../../migrations/0015_analytics.sql', import.meta.url),
    'utf8',
  );
  await sql.begin(async (tx) => {
    await tx`select pg_advisory_xact_lock(7015)`;
    await tx`create table if not exists schema_migrations(name text primary key, applied_at timestamptz not null default now())`;
    const rows = await tx<
      { name: string }[]
    >`select name from schema_migrations where name=${name}`;
    if (rows.length > 0) return;
    await tx.unsafe(body);
    await tx`insert into schema_migrations(name) values(${name})`;
  });
}
