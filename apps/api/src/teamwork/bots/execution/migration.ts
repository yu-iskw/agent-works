import { readFileSync } from 'node:fs';

import { applyMigration } from '../../../db.js';

import type postgres from 'postgres';

export async function applyBotExecutionMigration(sql: postgres.Sql): Promise<void> {
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- fixed repository migration
  const body = readFileSync(
    new URL('../../../../migrations/0033_bot_execution.sql', import.meta.url),
    'utf8',
  );
  await sql.begin(async (tx) => {
    await tx`select pg_advisory_xact_lock(7017)`;
    await applyMigration(tx, '0033_bot_execution.sql', body);
  });
}
