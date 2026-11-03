import { readFileSync } from 'node:fs';

import { rowClaimReady } from '../ports/schedule-row-claim-cutover.js';

import type postgres from 'postgres';

const pending = new WeakMap<postgres.Sql, Promise<void>>();

/** Applies 0013, 0026, then 0027 under advisory lock 7013. Idempotent, recorded in schema_migrations. */
export function outboxReady(sql: postgres.Sql): Promise<void> {
  const previous = pending.get(sql);
  if (previous !== undefined) return previous;
  const promise = rowClaimReady(sql).then(() => applyMigration(sql));
  pending.set(sql, promise);
  return promise;
}

async function applyMigration(sql: postgres.Sql): Promise<void> {
  const name = '0027_dispatch_outbox.sql';
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- fixed module-relative migration URL
  const body = readFileSync(
    new URL('../../migrations/0027_dispatch_outbox.sql', import.meta.url),
    'utf8',
  );
  await sql.begin(async (tx) => {
    await tx`select pg_advisory_xact_lock(7013)`;
    const rows = await tx<
      { name: string }[]
    >`select name from schema_migrations where name=${name}`;
    if (rows.length > 0) return;
    await tx.unsafe(body);
    await tx`insert into schema_migrations(name) values(${name})`;
  });
}
