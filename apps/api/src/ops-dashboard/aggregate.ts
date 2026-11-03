import { admissionReady } from '../admission/migration.js';
import { workerReady } from '../worker/migration.js';

import { attributeLines } from './billing.js';

import type { BillingLine, LedgerOwner } from './billing.js';
import type { CostCategories, OpsDashboard, OpsScope, OpsWindow } from './types.js';
import type postgres from 'postgres';

const COLUMN: ReadonlyMap<string, string> = new Map([
  ['member', 'member_id'],
  ['bot', 'bot_id'],
  ['segment', 'segment_id'],
]);

/** Every aggregate joins the admission ledger as `r`; the scope is one predicate on it. */
export function scopePredicate(sql: postgres.Sql, scope: OpsScope) {
  if (scope.kind === 'all') return sql`true`;
  const column = COLUMN.get(scope.kind);
  if (column === undefined) throw new Error('unknown scope kind');
  return sql`r.${sql(column)} = ${scope.id}`;
}

const safe = (text: string): number => {
  const value = Number(text);
  if (!Number.isSafeInteger(value)) throw new RangeError('micros overflow');
  return value;
};

export type BillingSource = { lines(): Promise<readonly BillingLine[]> };

export async function loadLedgerOwners(
  sql: postgres.Sql,
  executionIds: readonly string[],
): Promise<ReadonlyMap<string, LedgerOwner>> {
  if (executionIds.length === 0) return new Map();
  const rows = await sql<
    { execution_id: string; member_id: string; bot_id: string; segment_id: string }[]
  >`select execution_id, member_id, bot_id, segment_id from admission_reservations
    where execution_id in ${sql([...new Set(executionIds)])}`;
  return new Map(
    rows.map((row) => [
      row.execution_id,
      { memberId: row.member_id, botId: row.bot_id, segmentId: row.segment_id },
    ]),
  );
}

type BilledCategory = CostCategories['billed'];
type UnassignedCategory = CostCategories['unassigned'];

async function billingCategories(
  sql: postgres.Sql,
  scope: OpsScope,
  billing: BillingSource | undefined,
): Promise<{ billed: BilledCategory; unassigned: UnassignedCategory }> {
  const unassigned = { lines: 0, micros: 0, noLabel: 0, unknownExecution: 0 };
  const billed = { status: 'not_provided' as BilledCategory['status'], lines: 0, micros: 0 };
  if (billing === undefined) return { billed, unassigned };
  const lines = await billing.lines();
  const owners = await loadLedgerOwners(
    sql,
    lines.flatMap((line) => (line.executionId === null ? [] : [line.executionId])),
  );
  billed.status = 'provided';
  for (const row of attributeLines(lines, owners)) {
    if (row.kind === 'unassigned') {
      if (scope.kind === 'all') addUnassigned(unassigned, row.line.amountMicros, row.reason);
    } else if (inScope(scope, row.kind, row.owner, row.segmentId)) {
      billed.lines += 1;
      billed.micros += row.line.amountMicros;
    }
  }
  return { billed, unassigned };
}

function addUnassigned(
  total: { lines: number; micros: number; noLabel: number; unknownExecution: number },
  micros: number,
  reason: 'no_label' | 'unknown_execution' | undefined,
): void {
  total.lines += 1;
  total.micros += micros;
  if (reason === 'no_label') total.noLabel += 1;
  else total.unknownExecution += 1;
}

async function costCategories(
  sql: postgres.Sql,
  scope: OpsScope,
  window: OpsWindow,
  billing: BillingSource | undefined,
): Promise<CostCategories> {
  const [ledger] = await sql<{ n: number; est: string; rec: string; ok: number }[]>`
    select count(*)::int as n,
      coalesce(sum(r.estimated_cost_micros), 0)::text as est,
      coalesce(sum(r.cost_micros), 0)::text as rec,
      count(*) filter (where r.state = 'succeeded')::int as ok
    from admission_reservations r
    where r.created_at >= ${window.from}::timestamptz and r.created_at < ${window.to}::timestamptz
      and ${scopePredicate(sql, scope)}`;
  const recorded = safe(ledger.rec);
  const { billed, unassigned } = await billingCategories(sql, scope, billing);
  return {
    estimated: {
      executions: ledger.n,
      estimatedMicros: safe(ledger.est),
      recordedMicros: recorded,
    },
    billed,
    unassigned,
    perSuccessfulTaskMicros: ledger.ok === 0 ? null : Math.round(recorded / ledger.ok),
    succeededExecutions: ledger.ok,
  };
}

function inScope(
  scope: OpsScope,
  kind: 'execution' | 'team',
  owner: LedgerOwner | null,
  segmentId: string | null,
): boolean {
  if (scope.kind === 'all') return true;
  if (scope.kind === 'segment') return segmentId === scope.id;
  if (kind === 'team' || owner === null) return false;
  return scope.kind === 'member' ? owner.memberId === scope.id : owner.botId === scope.id;
}

export async function aggregate(
  sql: postgres.Sql,
  scope: OpsScope,
  window: OpsWindow,
  now: string,
  billing?: BillingSource,
): Promise<OpsDashboard> {
  await workerReady(sql);
  await admissionReady(sql);
  const where = scopePredicate(sql, scope);
  const inWindow = sql`sr.fire_at >= ${window.from}::timestamptz and sr.fire_at < ${window.to}::timestamptz`;
  const [latency] = await sql<
    { n: number; p50: number | null; p95: number | null; max: number | null }[]
  >`select count(*)::int as n,
      percentile_disc(0.5) within group (order by lat)::float8 as p50,
      percentile_disc(0.95) within group (order by lat)::float8 as p95,
      max(lat)::float8 as max
    from (
      select extract(epoch from (o.created_at - sr.fire_at)) * 1000 as lat
      from schedule_runs sr
      join (select execution_id, min(created_at) as created_at from dispatch_outbox group by execution_id) o
        on o.execution_id = sr.id
      left join admission_reservations r on r.execution_id = sr.id
      where ${inWindow} and ${where}) t`;
  const [backlog] = await sql<
    { queued: number; running: number; stuck: number; oldest: number | null }[]
  >`select count(*) filter (where w.state = 'queued')::int as queued,
      count(*) filter (where w.state = 'running')::int as running,
      count(*) filter (where w.state in ('awaiting-reconciliation', 'quarantined'))::int as stuck,
      (extract(epoch from (${now}::timestamptz - min(w.next_attempt_at) filter (where w.state = 'queued'))) * 1000)::float8 as oldest
    from worker_executions w left join admission_reservations r on r.execution_id = w.execution_id
    where ${where}`;
  const [outbox] = await sql<
    { pending: number; published: number; abandoned: number; oldest: number | null }[]
  >`select count(*) filter (where o.state = 'pending')::int as pending,
      count(*) filter (where o.state = 'published')::int as published,
      count(*) filter (where o.state = 'abandoned')::int as abandoned,
      (extract(epoch from (${now}::timestamptz - min(o.created_at) filter (where o.state = 'pending'))) * 1000)::float8 as oldest
    from dispatch_outbox o left join admission_reservations r on r.execution_id = o.execution_id
    where ${where}`;
  const [retries] = await sql<{ n: number; attempts: number; retries: number }[]>`
    select count(*)::int as n, coalesce(sum(w.attempts), 0)::int as attempts,
      coalesce(sum(greatest(w.attempts - 1, 0)), 0)::int as retries
    from worker_executions w
    join schedule_runs sr on sr.id = w.execution_id
    left join admission_reservations r on r.execution_id = w.execution_id
    where ${inWindow} and ${where}`;
  const states = await sql<{ state: string; n: number }[]>`
    select r.state, count(*)::int as n from admission_reservations r
    where r.created_at >= ${window.from}::timestamptz and r.created_at < ${window.to}::timestamptz
      and ${where}
    group by r.state`;
  const byState = Object.fromEntries(states.map((row) => [row.state, row.n]));
  const limits =
    scope.kind === 'all'
      ? null
      : ((
          await sql<{ max_concurrent: number | null; max_cost_micros: string | null }[]>`
            select max_concurrent, max_cost_micros::text from admission_limits
            where scope_kind = ${scope.kind} and scope_id = ${scope.id}`
        ).map((row) => ({
          maxConcurrent: row.max_concurrent,
          maxCostMicros: row.max_cost_micros === null ? null : safe(row.max_cost_micros),
        }))[0] ?? null);
  return {
    scope,
    window,
    generatedAt: now,
    dueToClaim: { samples: latency.n, p50Ms: latency.p50, p95Ms: latency.p95, maxMs: latency.max },
    backlog: {
      queued: backlog.queued,
      running: backlog.running,
      awaitingOrQuarantined: backlog.stuck,
      oldestQueuedMs: Math.max(0, backlog.oldest ?? 0),
    },
    outbox: {
      pending: outbox.pending,
      published: outbox.published,
      abandoned: outbox.abandoned,
      oldestPendingMs: Math.max(0, outbox.oldest ?? 0),
    },
    retries: {
      executions: retries.n,
      attempts: retries.attempts,
      retries: retries.retries,
      amplification: retries.n === 0 ? null : retries.attempts / retries.n,
    },
    quota: { active: states.find((row) => row.state === 'active')?.n ?? 0, byState, limits },
    cost: await costCategories(sql, scope, window, billing),
  };
}
