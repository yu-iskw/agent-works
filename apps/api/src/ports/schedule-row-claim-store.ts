import {
  eventTriggerSchema,
  receivedEventSchema,
  scheduleAuditSchema,
  scheduleRecordSchema,
  scheduleRunSchema,
} from '@agent-works/domain';

import { ScheduleConflict } from './schedule-port.js';
import { CutoverRefused, rowClaimReady } from './schedule-row-claim-cutover.js';

import type { ScheduleDriver, ScheduleState } from './schedule-port.js';
import type postgres from 'postgres';

export type Tx = postgres.TransactionSql;
export type RowClaimOptions = { lockTimeoutMs?: number; statementTimeoutMs?: number };

/** Rows one operation touches. Everything else stays unread and unlocked. */
export type Scope = {
  scheduleId: string;
  create?: boolean;
  triggerId?: string;
  runIds?: string[];
  eventKeys?: string[];
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const isUuid = (v: string): boolean => UUID.test(v);

const emptyState = (): ScheduleState => ({
  schedules: [],
  triggers: [],
  runs: [],
  events: [],
  audit: [],
});

export const stateDriver = (state: ScheduleState): ScheduleDriver => ({
  transaction: (operation) => Promise.resolve().then(() => operation(state)),
});

/** A short transaction as the row-claim writer. Refuses unless the owner row says rowclaim. */
export async function writerTransaction<T>(
  sql: postgres.Sql,
  options: RowClaimOptions,
  work: (tx: Tx) => Promise<T>,
): Promise<T> {
  await rowClaimReady(sql);
  try {
    return (await sql.begin(async (tx) => {
      await tx.unsafe(`set local lock_timeout = ${options.lockTimeoutMs ?? 2000}`);
      await tx.unsafe(`set local statement_timeout = ${options.statementTimeoutMs ?? 10000}`);
      await tx`select set_config('agentworks.scheduler_writer', 'rowclaim', true)`;
      const rows = await tx<
        { owner: string }[]
      >`select owner from scheduler_owner where singleton for share`;
      const owner = rows.at(0)?.owner;
      if (owner !== 'rowclaim')
        throw new CutoverRefused(`row-claim writer refused, owner is ${owner}`);
      return work(tx);
    })) as T;
  } catch (error) {
    if ((error as { code?: string }).code === '55P03') throw new ScheduleConflict('schedule busy');
    throw error;
  }
}

export async function loadScope(tx: Tx, scope: Scope): Promise<ScheduleState> {
  const { scheduleId: id } = scope;
  if (!isUuid(id)) return emptyState();
  let schedules = await tx<
    { payload: unknown }[]
  >`select payload from schedules where id = ${id}::uuid for update`;
  if (schedules.length === 0 && scope.create === true) {
    await tx`select pg_advisory_xact_lock(7014, hashtext(${id}))`;
    schedules = await tx<
      { payload: unknown }[]
    >`select payload from schedules where id = ${id}::uuid for update`;
  }
  const triggerId = scope.triggerId !== undefined && isUuid(scope.triggerId) ? scope.triggerId : id;
  const triggers = await tx<
    { payload: unknown }[]
  >`select payload from event_triggers where schedule_id = ${id}::uuid or id = ${triggerId}::uuid order by id`;
  const runs = await tx<
    { payload: unknown }[]
  >`select payload from schedule_runs where id in (select jsonb_array_elements_text(${tx.json(scope.runIds ?? [])})) order by fire_at, id`;
  const events = await tx<
    { payload: unknown }[]
  >`select payload from received_events where key in (select jsonb_array_elements_text(${tx.json(scope.eventKeys ?? [])})) or run_id in (select jsonb_array_elements_text(${tx.json(scope.runIds ?? [])})) order by key`;
  return {
    schedules: schedules.map((v) => scheduleRecordSchema.parse(v.payload)),
    triggers: triggers.map((v) => eventTriggerSchema.parse(v.payload)),
    runs: runs.map((v) => scheduleRunSchema.parse(v.payload)),
    events: events.map((v) => receivedEventSchema.parse(v.payload)),
    audit: [],
  };
}

const changed = <T>(rows: T[], row: T, key: (v: T) => string) =>
  !rows.some((v) => key(v) === key(row) && JSON.stringify(v) === JSON.stringify(row));

/** Writes only rows that differ from `before`, in dependency order. Audit is append-only. */
export async function persist(tx: Tx, s: ScheduleState, before: ScheduleState): Promise<void> {
  for (const row of s.schedules) {
    if (!changed(before.schedules, row, (v) => v.spec.id)) continue;
    await tx`insert into schedules(id,sponsor_sub,revision,state,expires_at,payload) values(${row.spec.id},${row.spec.sponsor.sub},${row.revision},${row.state},${row.spec.expiresAt},${tx.json(row)}) on conflict(id) do update set revision=excluded.revision,state=excluded.state,payload=excluded.payload`;
  }
  for (const row of s.triggers) {
    if (before.triggers.some((v) => v.id === row.id)) continue;
    await tx`insert into event_triggers(id,schedule_id,source,signing_key_id,payload) values(${row.id},${row.scheduleId},${row.source},${row.signingKeyId},${tx.json(row)})`;
  }
  await persistRuns(tx, s, before);
  await persistEvidence(tx, s, before);
}

async function persistRuns(tx: Tx, s: ScheduleState, before: ScheduleState): Promise<void> {
  for (const row of s.runs) {
    if (!changed(before.runs, row, (v) => v.id)) continue;
    await tx`insert into schedule_runs(id,schedule_id,fire_at,event_key,status,fence,lease_until,task_id,payload) values(${row.id},${row.scheduleId},${row.fireAt},${row.eventKey},${row.status},${row.fence},${row.leaseUntil},${row.taskId},${tx.json(row)}) on conflict(id) do update set status=excluded.status,fence=excluded.fence,lease_until=excluded.lease_until,task_id=excluded.task_id,payload=excluded.payload`;
  }
}

async function persistEvidence(tx: Tx, s: ScheduleState, before: ScheduleState): Promise<void> {
  for (const row of s.events) {
    if (before.events.some((v) => v.key === row.key)) continue;
    await tx`insert into received_events(key,source,source_event_id,trigger_id,run_id,trust,payload) values(${row.key},${row.source},${row.eventId},${row.triggerId},${row.runId},${row.trust},${tx.json(row)})`;
  }
  for (const row of s.audit) {
    await tx`insert into schedule_audit(id,schedule_id,payload) values(${scheduleAuditSchema.parse(row).id},${row.scheduleId},${tx.json(row)})`;
  }
}

export const setNextDue = (tx: Tx, id: string, nextDue: string | null) =>
  tx`update schedules set next_due = ${nextDue} where id = ${id}::uuid`;
