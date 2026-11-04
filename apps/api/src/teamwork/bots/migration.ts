import { readFileSync } from 'node:fs';

import { applyMigration } from '../../db.js';

import type postgres from 'postgres';

const name = '0031_bots.sql';
export async function applyBotsMigration(sql: postgres.Sql): Promise<void> {
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- fixed repository migration URL
  const body = readFileSync(new URL('../../../migrations/0031_bots.sql', import.meta.url), 'utf8');
  await sql.begin(async (tx) => {
    await tx`select pg_advisory_xact_lock(7017)`;
    await applyMigration(tx, name, body);
  });
}
