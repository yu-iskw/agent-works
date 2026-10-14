import { emptyGovernanceState } from '../ports/governance.js';
import { withPostgresTransaction } from '../ports/postgres-transaction.js';

import { governanceReady } from './migration.js';
import { validateGovernanceState } from './state.js';

import type { GovernancePort, GovernanceState } from '../ports/governance.js';
import type postgres from 'postgres';

type Query = postgres.TransactionSql;
/** Fixed identifiers only. Each operation holds a short offline maintenance lock.
 * This deliberately favors atomic deletion evidence over throughput in the local pilot. */
const tables = {
  policies: 'governance_retention_policies',
  artifacts: 'governance_artifacts',
  derived: 'governance_derived',
  holds: 'governance_legal_holds',
  requests: 'governance_deletion_requests',
  tombstones: 'governance_tombstones',
  audit: 'governance_audit',
  revokedSources: 'governance_revoked_sources',
} as const;
export function createPostgresGovernancePort(sql: postgres.Sql): GovernancePort {
  async function transact<T>(operation: (state: GovernanceState) => T | Promise<T>): Promise<T> {
    await governanceReady(sql);
    return await withPostgresTransaction(sql, async (tx) => {
      await tx`select pg_advisory_xact_lock(7013)`;
      const state = await readState(tx);
      const previous = structuredClone(state);
      const result = await operation(state);
      const committed = structuredClone(state);
      validateGovernanceState(committed, previous);
      const detached = structuredClone(result);
      await persistState(tx, committed, previous);
      return detached;
    });
  }
  return {
    transact,
    async snapshot() {
      await governanceReady(sql);
      // Repeatable-read supplies one snapshot across all relations without a write lock.
      return await sql.begin('isolation level repeatable read read only', (tx) => readState(tx));
    },
  };
}
async function payloads<T>(tx: Query, table: string): Promise<T[]> {
  const rows = await tx<{ payload: T }[]>`select payload from ${tx(table)} order by id`;
  return rows.map((row) => row.payload);
}
async function readState(tx: Query): Promise<GovernanceState> {
  const state = emptyGovernanceState();
  state.policies = await payloads(tx, tables.policies);
  state.artifacts = await payloads(tx, tables.artifacts);
  state.derived = await payloads(tx, tables.derived);
  state.holds = await payloads(tx, tables.holds);
  state.holds.sort((a, b) => a.sequence - b.sequence);
  state.requests = await payloads(tx, tables.requests);
  state.tombstones = await payloads(tx, tables.tombstones);
  state.audit = await payloads(tx, tables.audit);
  const sources = await payloads<{ id: string }>(tx, tables.revokedSources);
  state.revokedSources = sources.map((row) => row.id);
  validateGovernanceState(state, emptyGovernanceState());
  return state;
}
async function appendRows<T>(
  tx: Query,
  table: string,
  rows: readonly T[],
  previous: readonly T[],
  key: (row: T) => string,
): Promise<void> {
  const existing = new Set(previous.map(key));
  for (const row of rows) {
    if (!existing.has(key(row)))
      await tx`insert into ${tx(table)} (id, payload) values (${key(row)}, ${tx.json(row as unknown as postgres.JSONValue)})`;
  }
}
async function upsertRows<T>(
  tx: Query,
  table: string,
  rows: readonly T[],
  key: (row: T) => string,
): Promise<void> {
  for (const row of rows) {
    await tx`insert into ${tx(table)} (id, payload) values (${key(row)}, ${tx.json(row as unknown as postgres.JSONValue)})
      on conflict (id) do update set payload = excluded.payload where ${tx(table)}.payload <> excluded.payload`;
  }
}
async function removeMissing<T>(
  tx: Query,
  table: string,
  before: readonly T[],
  after: readonly T[],
  key: (row: T) => string,
): Promise<void> {
  const ids = new Set(after.map(key));
  for (const row of before)
    if (!ids.has(key(row))) await tx`delete from ${tx(table)} where id = ${key(row)}`;
}
async function persistState(
  tx: Query,
  state: GovernanceState,
  previous: GovernanceState,
): Promise<void> {
  await appendRows(tx, tables.policies, state.policies, previous.policies, (row) => row.id);
  await appendRows(tx, tables.holds, state.holds, previous.holds, (row) => row.commandId);
  await appendRows(
    tx,
    tables.tombstones,
    state.tombstones,
    previous.tombstones,
    (row) => row.recordId,
  );
  await appendRows(tx, tables.audit, state.audit, previous.audit, (row) => row.eventId);
  await appendRows(
    tx,
    tables.revokedSources,
    state.revokedSources.map((id) => ({ id })),
    previous.revokedSources.map((id) => ({ id })),
    (row) => row.id,
  );
  await removeMissing(tx, tables.derived, previous.derived, state.derived, (row) => row.id);
  await removeMissing(
    tx,
    tables.artifacts,
    previous.artifacts,
    state.artifacts,
    (row) => row.record.id,
  );
  await upsertRows(tx, tables.artifacts, state.artifacts, (row) => row.record.id);
  await upsertRows(tx, tables.derived, state.derived, (row) => row.id);
  await upsertRows(tx, tables.requests, state.requests, (row) => row.requestId);
}
