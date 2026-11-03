import { readFileSync } from 'node:fs';

import { applyMigration } from '../db.js';

import type postgres from 'postgres';

const name = '0029_graph_execution.sql';

/** Applies 0029 after the workbench migrations, under the workbench advisory lock. Idempotent. */
export async function applyGraphMigration(sql: postgres.Sql): Promise<void> {
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- fixed module-relative path
  const body = readFileSync(new URL(`../../migrations/${name}`, import.meta.url), 'utf8');
  await sql.begin(async (tx) => {
    await tx`select pg_advisory_xact_lock(7017)`;
    await applyMigration(tx, name, body);
  });
}
