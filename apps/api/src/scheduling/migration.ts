import { readFileSync } from 'node:fs';

import type postgres from 'postgres';
const pending = new WeakMap<postgres.Sql, Promise<void>>();
export function schedulesReady(sql: postgres.Sql): Promise<void> {
  const previous = pending.get(sql);
  if (previous !== undefined) return previous;
  const promise = apply(sql);
  pending.set(sql, promise);
  return promise;
}
async function apply(sql: postgres.Sql): Promise<void> {
  const name = '0013_schedules.sql';
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- fixed module-relative migration URL
  const body = readFileSync(
    new URL('../../migrations/0013_schedules.sql', import.meta.url),
    'utf8',
  );
  await sql.begin(async (tx) => {
    await tx`select pg_advisory_xact_lock(7013)`;
    await tx`create table if not exists schema_migrations(name text primary key, applied_at timestamptz not null default now())`;
    const rows = await tx<
      { name: string }[]
    >`select name from schema_migrations where name=${name}`;
    if (rows.length > 0) return;
    await tx.unsafe(body);
    await tx`insert into schema_migrations(name) values(${name})`;
  });
}
