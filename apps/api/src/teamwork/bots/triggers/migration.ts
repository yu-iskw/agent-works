import { readFileSync } from 'node:fs';

import { applyMigration } from '../../../db.js';

import type postgres from 'postgres';

export async function applyBotTriggersMigration(sql: postgres.Sql): Promise<void> {
  const body = readFileSync(
    new URL('../../../../migrations/0034_bot_triggers.sql', import.meta.url),
    'utf8',
  );
  await sql.begin(async (tx) => {
    await tx`select pg_advisory_xact_lock(7017)`;
    await applyMigration(tx, '0034_bot_triggers.sql', body);
  });
}
