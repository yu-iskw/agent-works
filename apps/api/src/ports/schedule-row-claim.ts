import {
  eventTriggerSchema,
  receivedEventSchema,
  scheduleAuditSchema,
  scheduleRecordSchema,
  scheduleRunId,
  scheduleRunSchema,
  scheduleSpecSchema,
  sourceEventKey,
} from '@agent-works/domain';

import { createSchedulePort } from '../scheduling/store.js';
import { dueSlot } from '../scheduling/time.js';

import { ScheduleConflict } from './schedule-port.js';
import { rowClaimReady } from './schedule-row-claim-cutover.js';
import { nextDueAfter } from './schedule-row-claim-due.js';
import {
  isUuid,
  loadScope,
  persist,
  setNextDue,
  stateDriver,
  writerTransaction,
} from './schedule-row-claim-store.js';

import type { SchedulePort, ScheduleState } from './schedule-port.js';
import type { RowClaimOptions, Scope, Tx } from './schedule-row-claim-store.js';
import type { ScheduleRecord, ScheduleRun } from '@agent-works/domain';
import type postgres from 'postgres';

export type ClaimDueInput = { now: string; limit: number; owner: string; leaseMs: number };
export type RowClaimSchedulePort = SchedulePort & {
  /**
   * One short transaction: lock up to `limit` due schedules with FOR UPDATE SKIP LOCKED, claim the
   * latest due slot of each (catch-up once), advance the cursor and recompute next_due.
   * No remote call happens inside. Returns the runs this call claimed.
   */
  claimDue(input: ClaimDueInput): Promise<ScheduleRun[]>;
};

export function createRowClaimSchedulePort(
  sql: postgres.Sql,
  options: RowClaimOptions = {},
): RowClaimSchedulePort {
  const read = async <T>(
    query: () => Promise<{ payload: unknown }[]>,
    parse: (v: unknown) => T,
  ) => {
    await rowClaimReady(sql);
    return (await query()).map((v) => parse(v.payload));
  };
  const parseRecord = (v: unknown) => scheduleRecordSchema.parse(v);
  const scoped = async <T>(
    scope: Scope,
    refreshDue: boolean,
    operation: (port: SchedulePort) => Promise<T>,
  ): Promise<T> =>
    writerTransaction(sql, options, async (tx) => {
      const state = await loadScope(tx, scope);
      const before = structuredClone(state);
      const result = structuredClone(await operation(createSchedulePort(stateDriver(state))));
      await persist(tx, state, before);
      const row = state.schedules.at(0);
      if (refreshDue && row !== undefined)
        await setNextDue(tx, row.spec.id, dueOf(row, state.triggers.length > 0));
      return result;
    });
  return {
    create(spec, actor, at, trigger) {
      const parsed = scheduleSpecSchema.parse(spec);
      return scoped({ scheduleId: parsed.id, create: true, triggerId: trigger?.id }, true, (p) =>
        p.create(parsed, actor, at, trigger),
      );
    },
    change: (...args: Parameters<SchedulePort['change']>) =>
      scoped({ scheduleId: args[1] }, true, (p) => p.change(...args)),
    advance: (id, cursor) => scoped({ scheduleId: id }, true, (p) => p.advance(id, cursor)),
    claim(input) {
      const key = input.event?.key ?? null;
      const scope = {
        scheduleId: input.scheduleId,
        runIds: [scheduleRunId(input.scheduleId, input.fireAt, key)],
        eventKeys: key === null ? [] : [key],
      };
      return scoped(scope, false, (p) => p.claim(input));
    },
    finish: (run, result, at) =>
      scoped({ scheduleId: run.scheduleId, runIds: [run.id] }, false, (p) =>
        p.finish(run, result, at),
      ),
    claimDue: (input) => claimDue(sql, options, input),
    all: () => read(() => sql`select payload from schedules order by id`, parseRecord),
    list: (subject) =>
      read(
        () => sql`select payload from schedules where sponsor_sub = ${subject} order by id`,
        parseRecord,
      ),
    async read(subject, id) {
      if (!isUuid(id)) return undefined;
      const rows = await read(
        () =>
          sql`select payload from schedules where id = ${id}::uuid and sponsor_sub = ${subject}`,
        parseRecord,
      );
      return rows[0];
    },
    runs(id) {
      if (!isUuid(id)) return Promise.resolve([]);
      return read(
        () =>
          sql`select payload from schedule_runs where schedule_id = ${id}::uuid order by fire_at, id`,
        (v) => scheduleRunSchema.parse(v),
      );
    },
    history: (subject) =>
      read(
        () =>
          sql`select a.payload from schedule_audit a join schedules s on s.id = a.schedule_id where s.sponsor_sub = ${subject} order by a.seq`,
        (v) => scheduleAuditSchema.parse(v),
      ),
    triggers: (subject) =>
      read(
        () =>
          sql`select t.payload from event_triggers t join schedules s on s.id = t.schedule_id where s.sponsor_sub = ${subject} order by t.id`,
        (v) => eventTriggerSchema.parse(v),
      ),
    async trigger(id) {
      if (!isUuid(id)) return undefined;
      const rows = await read(
        () => sql`select payload from event_triggers where id = ${id}::uuid`,
        (v) => eventTriggerSchema.parse(v),
      );
      return rows[0];
    },
    async eventForRun(runId) {
      const rows = await read(
        () => sql`select payload from received_events where run_id = ${runId}`,
        (v) => receivedEventSchema.parse(v),
      );
      return rows[0];
    },
    async received(source, eventId) {
      const rows = await read(
        () =>
          sql`select payload from received_events where key = ${sourceEventKey(source, eventId)}`,
        (v) => receivedEventSchema.parse(v),
      );
      return rows[0];
    },
  };
}

/** Event-only and inactive schedules have no due row; payload.cursor stays authoritative. */
function dueOf(row: ScheduleRecord, hasTrigger: boolean): string | null {
  if (row.state !== 'active' || hasTrigger) return null;
  return nextDueAfter(row.spec, row.cursor);
}

/** Runs inside the claim transaction for each newly claimed run (the SCH-02 outbox write). */
export type OnClaimed = (tx: Tx, run: ScheduleRun) => Promise<void>;

export async function claimDue(
  sql: postgres.Sql,
  options: RowClaimOptions,
  input: ClaimDueInput,
  onClaimed?: OnClaimed,
): Promise<ScheduleRun[]> {
  if (!Number.isInteger(input.limit) || input.limit < 1 || input.limit > 500)
    throw new ScheduleConflict('invalid batch');
  const now = new Date(input.now);
  if (now.toISOString() !== input.now) throw new ScheduleConflict('invalid instant');
  return writerTransaction(sql, options, async (tx) => {
    const due = await tx<{ payload: unknown }[]>`select payload from schedules
      where next_due <= ${input.now} order by next_due, id limit ${input.limit}
      for update skip locked`;
    const claimed: ScheduleRun[] = [];
    for (const { payload } of due) {
      const run = await claimOne(tx, scheduleRecordSchema.parse(payload), input);
      if (run !== undefined) {
        claimed.push(run);
        await onClaimed?.(tx, run);
      }
    }
    return claimed;
  });
}

async function claimOne(
  tx: Tx,
  record: ScheduleRecord,
  input: ClaimDueInput,
): Promise<ScheduleRun | undefined> {
  const now = new Date(input.now);
  const live = record.state === 'active' && Date.parse(record.spec.expiresAt) > now.getTime();
  const state: ScheduleState = {
    schedules: [record],
    triggers: [],
    runs: [],
    events: [],
    audit: [],
  };
  const before = structuredClone(state);
  const port = createSchedulePort(stateDriver(state));
  const slot = live ? dueSlot(record.spec, record.cursor, now) : undefined;
  let run: ScheduleRun | undefined;
  if (slot !== undefined) {
    const id = scheduleRunId(record.spec.id, slot, null);
    const rows = await tx<
      { payload: unknown }[]
    >`select payload from schedule_runs where id = ${id}`;
    state.runs.push(...rows.map((v) => scheduleRunSchema.parse(v.payload)));
    before.runs.push(...structuredClone(state.runs));
    run = await port.claim({
      scheduleId: record.spec.id,
      fireAt: slot,
      owner: input.owner,
      now: input.now,
      leaseMs: input.leaseMs,
      event: null,
    });
  }
  if (live) await port.advance(record.spec.id, input.now);
  await persist(tx, state, before);
  await setNextDue(tx, record.spec.id, live ? dueOf(record, false) : null);
  return run === undefined ? undefined : structuredClone(run);
}
