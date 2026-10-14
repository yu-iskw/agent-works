import {
  memoryAuditSchema,
  memoryConsentSchema,
  memoryItemSchema,
  memoryTombstoneSchema,
} from '@agent-works/domain/user-memory';

import { userMemoryReady } from '../memory/migration.js';
import { validateMemoryState } from '../memory/state.js';

import { withPostgresTransaction } from './postgres-transaction.js';

import type { MemoryState, MemoryStore } from './user-memory.js';
import type postgres from 'postgres';
/** Serializable local state transaction; advisory lock coordinates independent pools. */
export function createPostgresUserMemoryStore(sql: postgres.Sql): MemoryStore {
  return {
    async transaction<T>(operation: (state: MemoryState) => T): Promise<T> {
      await userMemoryReady(sql);
      return await withPostgresTransaction(sql, async (tx) => {
        await tx`select pg_advisory_xact_lock(7016)`;
        const state = await loadMemory(tx);
        const before = structuredClone(state);
        const result = operation(state);
        validateMemoryState(state, before);
        await saveMemory(tx, state, before);
        return structuredClone(result);
      });
    },
  };
}
async function loadMemory(tx: postgres.TransactionSql): Promise<MemoryState> {
  const consents = await tx<
    { payload: unknown }[]
  >`select payload from user_memory_consents order by tenant,owner`;
  const items = await tx<{ payload: unknown }[]>`select payload from user_memory_items order by id`;
  const history = await tx<
    { payload: unknown }[]
  >`select payload from user_memory_history order by id,revision`;
  const audit = await tx<
    { payload: unknown }[]
  >`select payload from user_memory_audit order by seq`;
  const tombstones = await tx<
    { payload: unknown }[]
  >`select payload from user_memory_tombstones order by key`;
  const revoked = await tx<
    { source_ref: string }[]
  >`select source_ref from user_memory_revoked_sources order by source_ref`;
  return {
    consents: consents.map((row) => memoryConsentSchema.parse(row.payload)),
    items: items.map((row) => memoryItemSchema.parse(row.payload)),
    history: history.map((row) => memoryItemSchema.parse(row.payload)),
    audit: audit.map((row) => memoryAuditSchema.parse(row.payload)),
    tombstones: tombstones.map((row) => memoryTombstoneSchema.parse(row.payload)),
    revokedSources: revoked.map((row) => row.source_ref),
  };
}
async function saveMemory(
  tx: postgres.TransactionSql,
  state: MemoryState,
  before: MemoryState,
): Promise<void> {
  for (const row of before.consents)
    if (
      !state.consents.some(
        (consent) => consent.tenant === row.tenant && consent.owner === row.owner,
      )
    )
      await tx`delete from user_memory_consents where tenant=${row.tenant} and owner=${row.owner}`;
  for (const row of state.consents)
    await tx`insert into user_memory_consents(tenant,owner,revision,payload) values(${row.tenant},${row.owner},${row.revision},${tx.json(row)}) on conflict(tenant,owner) do update set revision=excluded.revision,payload=excluded.payload`;
  for (const row of before.items)
    if (!state.items.some((item) => item.id === row.id))
      await tx`delete from user_memory_items where id=${row.id}`;
  for (const row of state.items)
    await tx`insert into user_memory_items(id,tenant,owner,agent,revision,source_ref,expires_at,legal_hold,payload) values(${row.id},${row.tenant},${row.owner},${row.agent},${row.revision},${row.origin.sourceRef},${row.expiresAt},${row.legalHold},${tx.json(row)}) on conflict(id) do update set revision=excluded.revision,legal_hold=excluded.legal_hold,payload=excluded.payload`;
  for (const row of state.history)
    if (!before.history.some((item) => item.id === row.id && item.revision === row.revision))
      await tx`insert into user_memory_history(id,revision,tenant,owner,payload) values(${row.id},${row.revision},${row.tenant},${row.owner},${tx.json(row)})`;
  await saveMemoryEvidence(tx, state, before);
}
async function saveMemoryEvidence(
  tx: postgres.TransactionSql,
  state: MemoryState,
  before: MemoryState,
): Promise<void> {
  for (const row of state.audit)
    if (!before.audit.some((item) => item.id === row.id))
      await tx`insert into user_memory_audit(id,payload) values(${row.id},${tx.json(row)})`;
  for (const row of state.tombstones)
    await tx`insert into user_memory_tombstones(key,payload) values(${row.tenantHash + ':' + row.idHash},${tx.json(row)}) on conflict(key) do nothing`;
  for (const ref of state.revokedSources)
    await tx`insert into user_memory_revoked_sources(source_ref) values(${ref}) on conflict do nothing`;
}
