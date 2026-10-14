import { readFileSync } from 'node:fs';

import { taskLedgerReady } from '../ledger/postgres-ledger.js';

import type postgres from 'postgres';
const migration = '0014_model_routing_delegation.sql';
/** Skips bundle 1/2 migrations; registers only the exclusive routing/delegation migration. */
export async function applyModelRoutingMigration(sql: postgres.Sql): Promise<void> {
  await taskLedgerReady(sql);
  // Static repository migration path, never request controlled.
  // eslint-disable-next-line security/detect-non-literal-fs-filename
  const body = readFileSync(
    new URL('../../migrations/0014_model_routing_delegation.sql', import.meta.url),
    'utf8',
  );
  await sql.begin(async (tx) => {
    await tx`select pg_advisory_xact_lock(7014)`;
    const previous = await tx`select name from schema_migrations where name=${migration}`;
    if (previous.length > 0) return;
    await tx.unsafe(body);
    await tx`insert into schema_migrations(name) values (${migration})`;
  });
}
