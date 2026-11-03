import { writeFileSync } from 'node:fs';

import { afterAll, beforeAll, describe, expect, test } from 'vitest';

import { startDisposablePostgres, openSql } from '../ledger/disposable-postgres.js';
import { scheduleFixture } from '../scheduling/test-fixtures.js';

import { rowClaimReady, switchSchedulerOwner } from './schedule-row-claim-cutover.js';
import { createRowClaimSchedulePort } from './schedule-row-claim.js';
import { dockerAvailable, dropSchedulerSchema } from './schedule-row-claim.testkit.js';

import type { RowClaimSchedulePort } from './schedule-row-claim.js';
import type { DisposablePostgres } from '../ledger/disposable-postgres.js';
import type { Sql } from 'postgres';

const live = dockerAvailable();
const T0 = '2026-10-14T10:00:00.000Z';
const T1 = '2026-10-14T10:01:00.000Z';
const SYNTHETIC = 50000;
const REAL = 400;
const BATCH = 25;
let database: DisposablePostgres;
const pools: Sql[] = [];
const pool = () => {
  const p = openSql(database.url);
  pools.push(p);
  return p;
};

beforeAll(async () => {
  if (live) database = await startDisposablePostgres();
}, 60000);
afterAll(async () => {
  if (!live) return;
  await Promise.all(pools.map((p) => p.end({ timeout: 1 })));
  await database.stop();
});

type PlanNode = { 'Node Type': string; 'Index Name'?: string; Plans?: PlanNode[] };
const nodes = (node: PlanNode): PlanNode[] => [node, ...(node.Plans ?? []).flatMap(nodes)];
const pct = (sorted: number[], q: number) =>
  sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))];

async function drain(d: RowClaimSchedulePort, timings: number[]): Promise<string[]> {
  const mine: string[] = [];
  for (let empty = 0; empty < 2;) {
    const t = performance.now();
    const runs = await d.claimDue({ now: T1, limit: BATCH, owner: 'w', leaseMs: 30000 });
    timings.push(performance.now() - t);
    mine.push(...runs.map((r) => r.id));
    empty = runs.length === 0 ? empty + 1 : 0;
  }
  return mine;
}

describe.skipIf(!live)('due query uses the index and lock time stays bounded', () => {
  test('EXPLAIN ANALYZE plan and claim timings with 4 dispatchers', async () => {
    const sql = pool();
    await dropSchedulerSchema(sql);
    await rowClaimReady(sql);
    await switchSchedulerOwner(sql, 'legacy', 'rowclaim');
    const port = createRowClaimSchedulePort(sql);
    const specs = Array.from({ length: REAL }, () => scheduleFixture());
    for (let i = 0; i < specs.length; i += 8)
      await Promise.all(specs.slice(i, i + 8).map((s) => port.create(s, 'alice', T0)));
    await sql.begin(async (tx) => {
      await tx`select set_config('agentworks.scheduler_writer', 'rowclaim', true)`;
      await tx`insert into schedules(id, sponsor_sub, revision, state, expires_at, payload, next_due)
        select gen_random_uuid(), 'filler', 1, 'active', '2030-01-01', '{}'::jsonb, '2027-01-01'::timestamptz + n * interval '1 second'
        from generate_series(1, ${SYNTHETIC}) n`;
    });
    await sql`analyze schedules`;

    const plan = await sql.begin(async (tx) => {
      await tx`set local enable_seqscan = on`;
      const rows = await tx<{ 'QUERY PLAN': { Plan: PlanNode & Record<string, number> }[] }[]>`
        explain (analyze, buffers, format json)
        select payload from schedules where next_due <= ${T1}::timestamptz
        order by next_due, id limit ${BATCH} for update skip locked`;
      return rows[0]['QUERY PLAN'][0];
    });
    const kinds = nodes(plan.Plan).map((n) => n['Node Type']);
    const indexes = nodes(plan.Plan).flatMap((n) => (n['Index Name'] ? [n['Index Name']] : []));
    expect(indexes).toContain('schedules_next_due');
    expect(kinds).not.toContain('Seq Scan');

    const dispatchers = Array.from({ length: 4 }, () => createRowClaimSchedulePort(pool()));
    const timings: number[] = [];
    const started = performance.now();
    const claimed = await Promise.all(dispatchers.map((d) => drain(d, timings)));
    const wall = performance.now() - started;
    const all = claimed.flat();
    expect(all).toHaveLength(REAL);
    expect(new Set(all).size).toBe(REAL);
    const sorted = [...timings].sort((a, b) => a - b);
    const summary = {
      schedulesTotal: REAL + SYNTHETIC,
      dueSchedules: REAL,
      batch: BATCH,
      dispatchers: 4,
      claimDueCalls: timings.length,
      wallMs: Math.round(wall),
      claimDueMs: { p50: pct(sorted, 0.5), p95: pct(sorted, 0.95), max: sorted.at(-1) },
      plan: {
        nodeTypes: kinds,
        indexes,
        planningMs: plan['Planning Time' as never],
        executionMs: plan['Execution Time' as never],
        sharedHitBlocks: (plan.Plan as unknown as Record<string, number>)['Shared Hit Blocks'],
      },
      fullPlan: plan,
    };
    expect(sorted.at(-1)).toBeLessThan(2000);
    if (process.env.SCH01_EVIDENCE_OUT)
      // eslint-disable-next-line security/detect-non-literal-fs-filename -- operator-chosen evidence path
      writeFileSync(process.env.SCH01_EVIDENCE_OUT, JSON.stringify(summary, null, 2));
  }, 180000);
});
