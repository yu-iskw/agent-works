import { afterAll, beforeAll } from 'vitest';

import { openSql } from '../ledger/disposable-postgres.js';
import { applyModelRoutingMigration } from '../model-routing/migration.js';
import { delegationContract } from '../ports/delegation.contract.js';
import { startDrillPostgres } from '../reliability/disposable-postgres.js';

import { createPostgresDelegationPort } from './postgres.js';

import type { DisposablePostgres } from '../ledger/disposable-postgres.js';
import type postgres from 'postgres';
let database: DisposablePostgres | undefined;
let sql: postgres.Sql | undefined;
function query(): postgres.Sql {
  if (sql === undefined) throw new Error('fixture database');
  return sql;
}
beforeAll(async () => {
  database = await startDrillPostgres();
  sql = openSql(database.url);
  await applyModelRoutingMigration(sql);
}, 60000);
afterAll(async () => {
  await sql?.end({ timeout: 1 });
  await database?.stop();
});
delegationContract(() => createPostgresDelegationPort(query()));
