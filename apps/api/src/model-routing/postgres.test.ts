import { afterAll, beforeAll, expect, it } from 'vitest';

import { openSql } from '../ledger/disposable-postgres.js';
import { modelRoutingContract } from '../ports/model-routing.contract.js';
import { startDrillPostgres } from '../reliability/disposable-postgres.js';

import { applyModelRoutingMigration } from './migration.js';
import { createPostgresModelRoutingPort } from './postgres.js';

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
modelRoutingContract(() => createPostgresModelRoutingPort(query()));
it('migration 0014 registers once and does not apply bundle migrations', async () => {
  await applyModelRoutingMigration(query());
  const rows =
    await query()`select name from schema_migrations where name like '001%' order by name`;
  expect(rows.map((row) => row.name as string)).toEqual(['0014_model_routing_delegation.sql']);
});
it('enforces database-level pinned identity constraints', async () => {
  await expect(
    query()`insert into model_inference_records(inference_id,task_id,trace_id,model_id,model_version,region,governance_zone,status,payload) values('invalid','task','trace','','v','r','z','started','{}')`,
  ).rejects.toThrow();
});
