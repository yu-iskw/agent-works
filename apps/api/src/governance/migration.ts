import { readFileSync } from 'node:fs';

import type postgres from 'postgres';

const name = '0012_data_governance.sql';
const ready = new WeakMap<postgres.Sql, Promise<void>>();
// eslint-disable-next-line security/detect-non-literal-fs-filename -- fixed bundled migration
const body = readFileSync(
  new URL('../../migrations/0012_data_governance.sql', import.meta.url),
  'utf8',
);
export function governanceReady(sql: postgres.Sql): Promise<void> {
  const previous = ready.get(sql);
  if (previous !== undefined) return previous;
  const result = sql
    .begin(async (tx) => {
      await tx`select pg_advisory_xact_lock(7012)`;
      await tx`create table if not exists schema_migrations (name text primary key, applied_at timestamptz not null default now())`;
      const applied = await tx`select name from schema_migrations where name = ${name}`;
      if (applied.length === 0) {
        await tx.unsafe(body);
        await tx`insert into schema_migrations (name) values (${name})`;
      }
    })
    .then(() => undefined);
  ready.set(sql, result);
  void result.catch(() => ready.delete(sql));
  return result;
}
