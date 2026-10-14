import { readFileSync } from 'node:fs';

import { taskLedgerReady } from '../ledger/postgres-ledger.js';

import type postgres from 'postgres';

const migration = '0011_budgets.sql';
/** Opt-in migration runner, leaves the existing ledger and cancel implementation intact. */
export async function applyBudgetMigration(sql: postgres.Sql): Promise<void> {
  await taskLedgerReady(sql);
  // eslint-disable-next-line security/detect-non-literal-fs-filename
  const body = readFileSync(new URL('../../migrations/0011_budgets.sql', import.meta.url), 'utf8');
  await sql.begin(async (tx) => {
    await tx`select pg_advisory_xact_lock(7011)`;
    const rows = await tx<
      { name: string }[]
    >`select name from schema_migrations where name = ${migration}`;
    if (rows.length > 0) return;
    await tx.unsafe(body);
    await tx`insert into schema_migrations(name) values (${migration})`;
  });
}
