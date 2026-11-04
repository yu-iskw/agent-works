import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import os from 'node:os';

import { openSql } from '../../ledger/disposable-postgres.js';
import { createPostgresSchedulePort } from '../../ports/schedule-postgres.js';
import { schedulesReady } from '../migration.js';
import { scheduleFixture } from '../test-fixtures.js';

import type { SchedulePort } from '../../ports/schedule-port.js';
import type { Sql } from 'postgres';

/*
 * SCH-00 benchmark: the shipped global-advisory-lock store versus a bounded row claim that lives
 * only in this file. Both sides drain the same S due schedules (one UTC slot each) with N
 * concurrent dispatchers, each with its own connection pool.
 *
 * "current" runs what the scheduler tick runs per due schedule against the real store: claim,
 * then advance on a win. Every call is a transaction that takes advisory lock 7013 and reads and
 * rewrites the whole schedule state. The real tick makes about seven such calls per schedule
 * (runs, triggers, claim, advance, ...), so this undercounts the shipped cost.
 *
 * "rowclaim" claims up to `batch` due rows with FOR UPDATE SKIP LOCKED on an indexed predicate
 * and inserts the unique occurrence and outbox row and advances the cursor in one statement.
 */

type Side = 'current' | 'rowclaim';
export type Trial = {
  side: Side;
  dispatchers: number;
  schedules: number;
  batch: number | null;
  rep: number;
  startedAt: string;
  finishedAt: string;
  elapsedMs: number;
  /** Occurrences created per second of wall time. */
  throughputPerSec: number;
  /** Operations (transactions) issued by all dispatchers. */
  operations: number;
  /** Operations that created no occurrence: another dispatcher got there first or nothing was due. */
  wastedOperations: number;
  opLatencyMs: { p50: number; p95: number; max: number };
  /** Mean and max sessions blocked on a heavyweight lock, sampled every 25 ms. */
  lockWaiters: { mean: number; max: number; samples: number };
  occurrencesWon: number;
  uniqueRows: number;
  outboxRows: number;
  /** winners minus unique rows. Must be 0. */
  duplicates: number;
  /** schedules minus unique rows. Must be 0. */
  missing: number;
};

export type MachineShape = {
  cpuModel: string;
  logicalCpus: number;
  memoryGiB: number;
  platform: string;
  node: string;
  postgres: string;
  postgresMode: string;
  dockerVm: string | null;
  settings: Record<string, string>;
  loadAvgBefore: number[];
};

export type BenchOptions = {
  databaseUrl: string;
  schedules: number;
  dispatchers: readonly number[];
  repetitions: number;
  batch: number;
  /** Defaults to both. A side listed alone runs without its counterpart (scale-out probe). */
  sides?: readonly Side[];
};

const SLOT = '2026-10-14T10:01:00.000Z';
const T0 = '2026-10-14T10:00:00.000Z';
const resetTables = `drop table if exists sch00_outbox, sch00_runs, sch00_due cascade;
drop table if exists schedule_audit,received_events,schedule_runs,event_triggers,schedules cascade;
drop function if exists reject_schedule_audit_rewrite();
drop table if exists schema_migrations;`;

export function summarize(values: readonly number[]): {
  n: number;
  median: number;
  min: number;
  max: number;
} {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  const at = (index: number): number => sorted.at(index) ?? Number.NaN;
  const median = sorted.length % 2 === 1 ? at(mid) : (at(mid - 1) + at(mid)) / 2;
  return { n: sorted.length, median, min: sorted[0], max: sorted[sorted.length - 1] };
}

function percentile(sorted: readonly number[], q: number): number {
  if (sorted.length === 0) return 0;
  return sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))];
}

async function reset(sql: Sql): Promise<void> {
  await sql.unsafe(resetTables);
  await sql.unsafe(`
create table sch00_due(schedule_id uuid primary key, next_due timestamptz not null);
create index sch00_due_next on sch00_due(next_due, schedule_id);
create table sch00_runs(schedule_id uuid not null, fire_at timestamptz not null, run_id text not null, primary key(schedule_id, fire_at));
create table sch00_outbox(dispatch_id text primary key, run_id text not null unique, state text not null default 'pending');`);
  await schedulesReady(sql);
}

async function seed(
  sql: Sql,
  side: Side,
  schedules: number,
  setup: SchedulePort,
): Promise<string[]> {
  const ids: string[] = [];
  if (side === 'current') {
    for (let i = 0; i < schedules; i += 1) {
      const spec = scheduleFixture();
      await setup.create(spec, 'alice', T0);
      ids.push(spec.id);
    }
    ids.sort();
  } else {
    await sql`insert into sch00_due(schedule_id, next_due) select gen_random_uuid(), ${SLOT}::timestamptz from generate_series(1, ${schedules}::int)`;
  }
  return ids;
}

function startLockSampler(url: string): {
  stop(): Promise<{ mean: number; max: number; samples: number }>;
} {
  const probe = openSql(url);
  const state = { running: true };
  const counts: number[] = [];
  const loop = (async () => {
    while (state.running) {
      const [row] = await probe<
        { waiting: number }[]
      >`select count(*)::int as waiting from pg_stat_activity where datname = current_database() and pid <> pg_backend_pid() and wait_event_type = 'Lock'`;
      counts.push(row.waiting);
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  })();
  return {
    async stop() {
      state.running = false;
      await loop;
      await probe.end({ timeout: 1 });
      const total = counts.reduce((a, b) => a + b, 0);
      return {
        mean: counts.length === 0 ? 0 : total / counts.length,
        max: Math.max(0, ...counts),
        samples: counts.length,
      };
    },
  };
}

type DispatcherResult = { won: number; ops: number; wasted: number; latencies: number[] };

async function currentDispatcher(
  port: SchedulePort,
  ids: readonly string[],
): Promise<DispatcherResult> {
  const result: DispatcherResult = { won: 0, ops: 0, wasted: 0, latencies: [] };
  for (const scheduleId of ids) {
    const started = performance.now();
    const run = await port.claim({
      scheduleId,
      fireAt: SLOT,
      owner: 'bench',
      now: SLOT,
      leaseMs: 30000,
      event: null,
    });
    result.latencies.push(performance.now() - started);
    result.ops += 1;
    if (run === undefined) {
      result.wasted += 1;
      continue;
    }
    result.won += 1;
    const advanceStart = performance.now();
    await port.advance(scheduleId, SLOT);
    result.latencies.push(performance.now() - advanceStart);
    result.ops += 1;
  }
  return result;
}

async function rowClaimDispatcher(sql: Sql, batch: number): Promise<DispatcherResult> {
  const result: DispatcherResult = { won: 0, ops: 0, wasted: 0, latencies: [] };
  for (;;) {
    const started = performance.now();
    const [row] = await sql<{ picked: number; inserted: number }[]>`
with picked as (
  select schedule_id, next_due from sch00_due
  where next_due <= ${SLOT}::timestamptz
  order by next_due, schedule_id
  limit ${batch}
  for update skip locked
), ins as (
  insert into sch00_runs(schedule_id, fire_at, run_id)
  select schedule_id, next_due, md5(schedule_id::text || next_due::text) from picked
  on conflict do nothing
  returning run_id
), ob as (
  insert into sch00_outbox(dispatch_id, run_id) select md5('d' || run_id), run_id from ins returning 1
), adv as (
  update sch00_due d set next_due = d.next_due + interval '60 seconds'
  from picked p where d.schedule_id = p.schedule_id returning 1
)
select (select count(*) from picked)::int as picked, (select count(*) from ins)::int as inserted`;
    result.latencies.push(performance.now() - started);
    result.ops += 1;
    result.won += row.inserted;
    if (row.picked === 0) {
      result.wasted += 1;
      return result;
    }
    if (row.inserted < row.picked) result.wasted += 1;
  }
}

async function evidence(sql: Sql, side: Side): Promise<{ unique: number; outbox: number }> {
  if (side === 'current') {
    const [row] = await sql<
      { unique: number }[]
    >`select count(distinct (schedule_id, fire_at))::int as "unique" from schedule_runs`;
    return { unique: row.unique, outbox: -1 };
  }
  const [row] = await sql<
    { unique: number; outbox: number }[]
  >`select (select count(distinct (schedule_id, fire_at)) from sch00_runs)::int as "unique", (select count(*) from sch00_outbox)::int as outbox`;
  return row;
}

async function runTrial(
  options: Pick<BenchOptions, 'databaseUrl' | 'schedules' | 'batch'>,
  side: Side,
  dispatchers: number,
  rep: number,
): Promise<Trial> {
  const admin = openSql(options.databaseUrl);
  const pools = Array.from({ length: dispatchers }, () => openSql(options.databaseUrl));
  try {
    await reset(admin);
    const ids = await seed(admin, side, options.schedules, createPostgresSchedulePort(admin));
    await admin.unsafe('analyze');
    const sampler = startLockSampler(options.databaseUrl);
    const startedAt = new Date().toISOString();
    const t0 = performance.now();
    const results = await Promise.all(
      pools.map((pool) =>
        side === 'current'
          ? currentDispatcher(createPostgresSchedulePort(pool), ids)
          : rowClaimDispatcher(pool, options.batch),
      ),
    );
    const elapsedMs = performance.now() - t0;
    const finishedAt = new Date().toISOString();
    const waiters = await sampler.stop();
    const won = results.reduce((a, r) => a + r.won, 0);
    const found = await evidence(admin, side);
    const latencies = results.flatMap((r) => r.latencies).sort((a, b) => a - b);
    return {
      side,
      dispatchers,
      schedules: options.schedules,
      batch: side === 'rowclaim' ? options.batch : null,
      rep,
      startedAt,
      finishedAt,
      elapsedMs,
      throughputPerSec: won / (elapsedMs / 1000),
      operations: results.reduce((a, r) => a + r.ops, 0),
      wastedOperations: results.reduce((a, r) => a + r.wasted, 0),
      opLatencyMs: {
        p50: percentile(latencies, 0.5),
        p95: percentile(latencies, 0.95),
        max: latencies[latencies.length - 1] ?? 0,
      },
      lockWaiters: waiters,
      occurrencesWon: won,
      uniqueRows: found.unique,
      outboxRows: found.outbox,
      duplicates: won - found.unique,
      missing: options.schedules - found.unique,
    };
  } finally {
    await Promise.all(pools.map((p) => p.end({ timeout: 1 })));
    await admin.end({ timeout: 1 });
  }
}

/** Alternates the side that goes first each repetition so drift favours neither. */
export async function runBenchmark(options: BenchOptions): Promise<Trial[]> {
  const trials: Trial[] = [];
  for (let rep = 1; rep <= options.repetitions; rep += 1) {
    for (const dispatchers of options.dispatchers) {
      const order: Side[] = rep % 2 === 1 ? ['current', 'rowclaim'] : ['rowclaim', 'current'];
      for (const side of order.filter((v) => (options.sides ?? order).includes(v)))
        trials.push(await runTrial(options, side, dispatchers, rep));
    }
  }
  return trials;
}

/** Single-dispatcher current store at growing S: shows per-operation cost tracking total state. */
export async function runScaling(
  databaseUrl: string,
  sizes: readonly number[],
  repetitions: number,
): Promise<Trial[]> {
  const trials: Trial[] = [];
  for (let rep = 1; rep <= repetitions; rep += 1)
    for (const schedules of sizes)
      trials.push(await runTrial({ databaseUrl, schedules, batch: 0 }, 'current', 1, rep));
  return trials;
}

export async function machineShape(url: string): Promise<MachineShape> {
  const sql = openSql(url);
  try {
    const [{ version }] = await sql<{ version: string }[]>`select version()`;
    const rows = await sql<
      { name: string; setting: string }[]
    >`select name, setting from pg_settings where name in ('shared_buffers','max_connections','synchronous_commit','fsync','wal_level','random_page_cost')`;
    let dockerVm: string | null = null;
    if (!existsSync('/usr/lib/postgresql/16/bin/initdb')) {
      try {
        dockerVm = execFileSync(
          'docker',
          ['info', '--format', '{{.NCPU}} CPUs, {{.MemTotal}} bytes, {{.OperatingSystem}}'],
          { encoding: 'utf8' },
        ).trim();
      } catch {
        dockerVm = 'unknown';
      }
    }
    return {
      cpuModel: os.cpus()[0]?.model ?? 'unknown',
      logicalCpus: os.cpus().length,
      memoryGiB: Math.round(os.totalmem() / 2 ** 30),
      platform: `${os.platform()} ${os.release()} ${os.arch()}`,
      node: process.version,
      postgres: version,
      postgresMode:
        dockerVm === null ? 'local cluster' : 'docker postgres:16-alpine, data dir on tmpfs (512m)',
      dockerVm,
      settings: Object.fromEntries(rows.map((r) => [r.name, r.setting])),
      loadAvgBefore: os.loadavg(),
    };
  } finally {
    await sql.end({ timeout: 1 });
  }
}
