import { readFileSync } from 'node:fs';

import {
  capabilityVersionSchema,
  canonicalPayloadSha256,
  suspensionSchema,
} from '@agent-works/domain';

import { commandDigest, SuspensionConflict, validateDenial } from '../ports/suspension-ledger.js';

import { parseAdminCommand, prepareChange } from './mutation.js';

import type {
  AdminCommand,
  AdminResult,
  SuspensionAudit,
  SuspensionLedger,
  SuspensionSnapshot,
} from '../ports/suspension-ledger.js';
import type postgres from 'postgres';

const migration = '0010_suspensions.sql';
// eslint-disable-next-line security/detect-non-literal-fs-filename -- fixed bundled migration URL
const migrationSql = readFileSync(
  new URL('../../migrations/0010_suspensions.sql', import.meta.url),
  'utf8',
);
const migrations = new WeakMap<postgres.Sql, Promise<void>>();
type Query = postgres.Sql | postgres.TransactionSql;

export function suspensionLedgerReady(sql: postgres.Sql): Promise<void> {
  const previous = migrations.get(sql);
  if (previous !== undefined) return previous;
  const ready = sql
    .begin(async (tx) => {
      await tx`select pg_advisory_xact_lock(7010)`;
      await tx`create table if not exists schema_migrations (name text primary key, applied_at timestamptz not null default now())`;
      const applied = await tx`select name from schema_migrations where name = ${migration}`;
      if (applied.length === 0) {
        await tx.unsafe(migrationSql);
        await tx`insert into schema_migrations (name) values (${migration})`;
      }
    })
    .then(() => undefined);
  migrations.set(sql, ready);
  return ready;
}

export function createPostgresSuspensionLedger(sql: postgres.Sql): SuspensionLedger {
  return {
    async snapshot() {
      await suspensionLedgerReady(sql);
      return readSnapshot(sql);
    },
    async history() {
      await suspensionLedgerReady(sql);
      const rows = await sql<
        { payload: SuspensionAudit }[]
      >`select payload from suspension_history order by sequence`;
      return rows.map((row) => row.payload);
    },
    async change(input, actorSub, at) {
      const parsed = parseAdminCommand(input);
      await suspensionLedgerReady(sql);
      return sql.begin(async (tx) => {
        // One short serialized mutation transaction also arbitrates command IDs across targets.
        // Reads and invocations do not acquire this lock.
        await tx`select pg_advisory_xact_lock(7011)`;
        return commitChange(tx, parsed, actorSub, at);
      });
    },
    async deny(event) {
      event = validateDenial(event);
      await suspensionLedgerReady(sql);
      await sql.begin(async (tx) => {
        const rows = await tx<{ payload: SuspensionAudit; command_digest: string | null }[]>`
          insert into suspension_history (event_id, payload)
          values (${event.eventId}, ${tx.json(event as unknown as postgres.JSONValue)})
          on conflict (event_id) do nothing returning payload, command_digest
        `;
        if (rows.length > 0) return;
        const previous = await tx<{ payload: SuspensionAudit; command_digest: string | null }[]>`
          select payload, command_digest from suspension_history where event_id = ${event.eventId}
        `;
        if (
          previous.length === 0 ||
          previous[0].command_digest !== null ||
          canonicalPayloadSha256(previous[0].payload) !== canonicalPayloadSha256(event)
        )
          throw new SuspensionConflict('event id reused');
      });
    },
  };
}
async function readSnapshot(query: Query): Promise<SuspensionSnapshot> {
  // One statement snapshot avoids mixing state from different commits.
  const rows = await query<{ kind: string; payload: unknown }[]>`
    select 'suspension' as kind, payload from (
      select distinct on (target_key) payload from suspension_states order by target_key, revision desc
    ) s union all
    select 'version' as kind, payload from (
      select distinct on (pin_key) payload from capability_version_states order by pin_key, revision desc
    ) v
  `;
  return {
    suspensions: rows
      .filter((row) => row.kind === 'suspension')
      .map((row) => suspensionSchema.parse(row.payload)),
    versions: rows
      .filter((row) => row.kind === 'version')
      .map((row) => capabilityVersionSchema.parse(row.payload)),
  };
}
async function commitChange(
  tx: postgres.TransactionSql,
  input: AdminCommand,
  actorSub: string,
  at: Date,
): Promise<AdminResult> {
  const digest = commandDigest(input, actorSub);
  const previous = await tx<{ command_digest: string | null; result: AdminResult | null }[]>`
    select command_digest, result from suspension_history where event_id = ${input.command.commandId}
  `;
  if (previous.length > 0) {
    if (previous[0].command_digest !== digest || previous[0].result === null)
      throw new SuspensionConflict('command id reused');
    return { ...previous[0].result, replay: true };
  }
  const prepared = prepareChange(input, actorSub, at, await readSnapshot(tx));
  const payload = tx.json(prepared.result.record);
  if (input.kind === 'suspension') {
    await tx`insert into suspension_states (target_key, revision, command_id, payload)
      values (${prepared.key}, ${prepared.result.record.revision}, ${input.command.commandId}, ${payload})`;
  } else {
    await tx`insert into capability_version_states (pin_key, revision, command_id, payload)
      values (${prepared.key}, ${prepared.result.record.revision}, ${input.command.commandId}, ${payload})`;
  }
  await tx`insert into suspension_history (event_id, command_digest, payload, result)
    values (${prepared.audit.eventId}, ${digest}, ${tx.json(prepared.audit as unknown as postgres.JSONValue)}, ${tx.json(prepared.result)})`;
  return prepared.result;
}
