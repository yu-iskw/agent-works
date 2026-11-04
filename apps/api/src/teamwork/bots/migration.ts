import { readFileSync } from 'node:fs';

import { applyMigration } from '../../db.js';

import type postgres from 'postgres';

/**
 * The bot schema: 0031 (revisions, runs, steps), 0033 (execution columns, owner binding) and
 * 0034 (schedule cursors). Publishing writes a 0033 column and 0034 references 0031, so they are
 * always applied together, in order.
 * 0032 (skill packages) belongs to the package store and is applied by it.
 */
const MIGRATIONS = ['0031_bots.sql', '0033_bot_execution.sql', '0034_bot_triggers.sql'] as const;

export async function applyBotsMigration(sql: postgres.Sql): Promise<void> {
  const bodies = MIGRATIONS.map((name) => ({
    name,
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- fixed repository migration names
    body: readFileSync(new URL(`../../../migrations/${name}`, import.meta.url), 'utf8'),
  }));
  await sql.begin(async (tx) => {
    await tx`select pg_advisory_xact_lock(7017)`;
    for (const { name, body } of bodies) await applyMigration(tx, name, body);
  });
}
