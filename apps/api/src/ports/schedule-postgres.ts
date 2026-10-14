import {
  eventTriggerSchema,
  receivedEventSchema,
} from '../../../../packages/domain/dist/event-trigger.js';
import {
  scheduleRunSchema,
  scheduleAuditSchema,
} from '../../../../packages/domain/dist/schedule-run.js';
import { scheduleRecordSchema } from '../../../../packages/domain/dist/schedule.js';
import { schedulesReady } from '../scheduling/migration.js';
import { createSchedulePort } from '../scheduling/store.js';

import type { ScheduleDriver, SchedulePort, ScheduleState } from './schedule-port.js';
import type postgres from 'postgres';

export function createPostgresSchedulePort(sql: postgres.Sql): SchedulePort {
  return createSchedulePort(createPostgresScheduleDriver(sql));
}
function createPostgresScheduleDriver(sql: postgres.Sql): ScheduleDriver {
  return {
    async transaction<T>(operation: (state: ScheduleState) => T): Promise<T> {
      await schedulesReady(sql);
      return (await sql.begin(async (tx) => {
        await tx`select pg_advisory_xact_lock(7013)`;
        const state = await readState(tx);
        const before = structuredClone(state);
        const result = operation(state);
        await saveState(tx, state, before);
        return structuredClone(result);
      })) as T;
    },
  };
}
async function readState(tx: postgres.TransactionSql): Promise<ScheduleState> {
  const schedules = await tx<{ payload: unknown }[]>`select payload from schedules order by id`;
  const triggers = await tx<{ payload: unknown }[]>`select payload from event_triggers order by id`;
  const runs = await tx<
    { payload: unknown }[]
  >`select payload from schedule_runs order by fire_at,id`;
  const events = await tx<{ payload: unknown }[]>`select payload from received_events order by key`;
  const audit = await tx<{ payload: unknown }[]>`select payload from schedule_audit order by seq`;
  return {
    schedules: schedules.map((v) => scheduleRecordSchema.parse(v.payload)),
    triggers: triggers.map((v) => eventTriggerSchema.parse(v.payload)),
    runs: runs.map((v) => scheduleRunSchema.parse(v.payload)),
    events: events.map((v) => receivedEventSchema.parse(v.payload)),
    audit: audit.map((v) => scheduleAuditSchema.parse(v.payload)),
  };
}
async function saveState(
  tx: postgres.TransactionSql,
  s: ScheduleState,
  before: ScheduleState,
): Promise<void> {
  await saveSchedules(tx, s, before);
  await saveTriggers(tx, s, before);
  await saveRuns(tx, s, before);
  await saveEvidence(tx, s, before);
}
async function saveSchedules(
  tx: postgres.TransactionSql,
  s: ScheduleState,
  before: ScheduleState,
): Promise<void> {
  for (const row of s.schedules) {
    if (unchanged(before.schedules, row, (v) => v.spec.id)) continue;
    await tx`insert into schedules(id,sponsor_sub,revision,state,expires_at,payload) values(${row.spec.id},${row.spec.sponsor.sub},${row.revision},${row.state},${row.spec.expiresAt},${tx.json(row)}) on conflict(id) do update set revision=excluded.revision,state=excluded.state,payload=excluded.payload`;
  }
}
async function saveTriggers(
  tx: postgres.TransactionSql,
  s: ScheduleState,
  before: ScheduleState,
): Promise<void> {
  for (const row of s.triggers) {
    if (before.triggers.some((v) => v.id === row.id)) continue;
    await tx`insert into event_triggers(id,schedule_id,source,signing_key_id,payload) values(${row.id},${row.scheduleId},${row.source},${row.signingKeyId},${tx.json(row)})`;
  }
}
async function saveRuns(
  tx: postgres.TransactionSql,
  s: ScheduleState,
  before: ScheduleState,
): Promise<void> {
  for (const row of s.runs) {
    if (unchanged(before.runs, row, (v) => v.id)) continue;
    await tx`insert into schedule_runs(id,schedule_id,fire_at,event_key,status,fence,lease_until,task_id,payload) values(${row.id},${row.scheduleId},${row.fireAt},${row.eventKey},${row.status},${row.fence},${row.leaseUntil},${row.taskId},${tx.json(row)}) on conflict(id) do update set status=excluded.status,fence=excluded.fence,lease_until=excluded.lease_until,task_id=excluded.task_id,payload=excluded.payload`;
  }
}
async function saveEvidence(
  tx: postgres.TransactionSql,
  s: ScheduleState,
  before: ScheduleState,
): Promise<void> {
  for (const row of s.events) {
    if (before.events.some((v) => v.key === row.key)) continue;
    await tx`insert into received_events(key,source,source_event_id,trigger_id,run_id,trust,payload) values(${row.key},${row.source},${row.eventId},${row.triggerId},${row.runId},${row.trust},${tx.json(row)})`;
  }
  for (const row of s.audit) {
    if (before.audit.some((v) => v.id === row.id)) continue;
    await tx`insert into schedule_audit(id,schedule_id,payload) values(${row.id},${row.scheduleId},${tx.json(row)})`;
  }
}
function unchanged<T>(rows: T[], row: T, key: (v: T) => string): boolean {
  return rows.some((v) => key(v) === key(row) && JSON.stringify(v) === JSON.stringify(row));
}
