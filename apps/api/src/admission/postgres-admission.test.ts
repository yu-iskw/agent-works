import { execFileSync } from 'node:child_process';

import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest';

import { openSql, startDisposablePostgres } from '../ledger/disposable-postgres.js';
import { createMemorySuspensionLedger } from '../ports/memory/suspension-ledger.js';
import { createSuspensionEnforcer } from '../suspension/enforcement.js';
import { publishPins, suspendCommand, testAt, testContext } from '../suspension/test-fixtures.js';

import { admissionReady } from './migration.js';
import { createAdmissionService } from './postgres-admission.js';

import type { AdmissionService } from './postgres-admission.js';
import type { AdmissionRequest } from './types.js';
import type { DisposablePostgres } from '../ledger/disposable-postgres.js';
import type { Sql } from 'postgres';

function dockerAvailable(): boolean {
  try {
    execFileSync('docker', ['info'], { stdio: 'ignore', timeout: 3000 });
    return true;
  } catch {
    return existsLocalCluster();
  }
}
function existsLocalCluster(): boolean {
  try {
    execFileSync('test', ['-x', '/usr/lib/postgresql/16/bin/initdb']);
    return true;
  } catch {
    return false;
  }
}
const live = dockerAvailable();
const leaseMs = 60_000;
let database: DisposablePostgres | undefined;
let sql: Sql;
let clock = new Date('2026-11-03T00:00:00.000Z');
let service: AdmissionService;
const now = () => clock;
const advance = (ms: number) => {
  clock = new Date(clock.getTime() + ms);
};
let seq = 0;
function request(overrides: Partial<AdmissionRequest> = {}): AdmissionRequest {
  seq += 1;
  return {
    executionId: `exec-${seq}`,
    memberId: 'm1',
    botId: 'b1',
    segmentId: 's1',
    windowKey: 'w1',
    estimatedCostMicros: 0,
    ...overrides,
  };
}

beforeAll(async () => {
  if (!live) return;
  database = await startDisposablePostgres();
  sql = openSql(database.url);
  await admissionReady(sql);
}, 60_000);
afterAll(async () => {
  if (!live) return;
  await sql.end({ timeout: 1 });
  await database?.stop();
});
beforeEach(async () => {
  if (!live) return;
  await sql`truncate admission_limits, admission_scopes, admission_reservations, admission_token_buckets`;
  clock = new Date('2026-11-03T00:00:00.000Z');
  service = await createAdmissionService({ sql, leaseMs, now });
});

describe.skipIf(!live)('admission on real PostgreSQL', () => {
  test('migration 0025 applies idempotently', async () => {
    await admissionReady(sql);
    const rows = await sql<
      { count: number }[]
    >`select count(*)::int as count from schema_migrations where name = '0025_admission.sql'`;
    expect(rows[0].count).toBe(1);
  });

  test.each([
    ['segment', { segmentId: 's-cap' }, (i: number) => ({ memberId: `m${i}`, botId: `b${i}` })],
    ['member', { memberId: 'm-cap' }, (i: number) => ({ botId: `b${i}`, segmentId: `s${i}` })],
    ['bot', { botId: 'b-cap' }, (i: number) => ({ memberId: `m${i}`, segmentId: `s${i}` })],
  ] as const)(
    '%s cap holds under 40 parallel callers',
    async (kind, fixed, vary) => {
      const id = Object.values(fixed)[0];
      await service.setLimit(kind, id, { maxConcurrent: 5 });
      const results = await Promise.all(
        Array.from({ length: 40 }, (_, i) => service.admit(request({ ...vary(i), ...fixed }))),
      );
      expect(results.filter((r) => r.admitted)).toHaveLength(5);
      expect(results.filter((r) => !r.admitted && r.reason === `${kind}_cap`)).toHaveLength(35);
      expect(await service.inFlight(kind, id)).toBe(5);
    },
    30_000,
  );

  test('parallel redelivery of one execution takes one reservation and one token', async () => {
    await service.setProviderBucket('p', 5, 1);
    await service.setLimit('segment', 's1', { maxConcurrent: 1 });
    const one = request({ provider: 'p' });
    const results = await Promise.all(Array.from({ length: 12 }, () => service.admit(one)));
    expect(results.every((r) => r.admitted)).toBe(true);
    expect(results.filter((r) => r.admitted && !r.replay)).toHaveLength(1);
    const rows =
      await sql`select 1 from admission_reservations where execution_id = ${one.executionId}`;
    expect(rows).toHaveLength(1);
    const [bucket] = await sql<{ tokens: number }[]>`select tokens from admission_token_buckets`;
    expect(bucket.tokens).toBe(4);
  });

  test('an execution id reused for a different member is an identity conflict', async () => {
    const one = request();
    await service.admit(one);
    await expect(service.admit({ ...one, memberId: 'intruder' })).rejects.toThrow(/identity/);
  });

  test.each(['succeeded', 'failed', 'cancelled'] as const)(
    'release on %s frees the slot, is idempotent and blocks re-admission',
    async (outcome) => {
      await service.setLimit('member', 'm1', { maxConcurrent: 1 });
      const first = request();
      expect((await service.admit(first)).admitted).toBe(true);
      expect(await service.admit(request())).toMatchObject({ reason: 'member_cap' });
      expect(await service.release(first.executionId, outcome)).toBe(outcome);
      expect(await service.release(first.executionId, 'succeeded')).toBe(outcome);
      expect(await service.inFlight('member', 'm1')).toBe(0);
      expect(await service.admit(first)).toEqual({
        admitted: false,
        reason: 'already_finished',
        state: outcome,
      });
      expect((await service.admit(request())).admitted).toBe(true);
    },
  );

  test('expired leases are reclaimed by the sweep and lapsed holders are fenced', async () => {
    await service.setLimit('segment', 's1', { maxConcurrent: 2 });
    const a = request();
    const b = request();
    await service.admit(a);
    await service.admit(b);
    expect(await service.admit(request())).toMatchObject({ reason: 'segment_cap' });
    advance(leaseMs - 1);
    expect(await service.renew(a.executionId)).toBe(true);
    advance(2);
    expect(await service.sweepExpired()).toEqual([b.executionId]);
    expect(await service.sweepExpired()).toEqual([]);
    expect(await service.inFlight('segment', 's1')).toBe(1);
    expect((await service.admit(request())).admitted).toBe(true);
    expect(await service.renew(b.executionId)).toBe(false);
    expect(await service.release(b.executionId, 'failed')).toBe('failed');
  });

  test('a lapsed lease stops counting before any sweep and re-admission keeps one row', async () => {
    await service.setLimit('segment', 's1', { maxConcurrent: 1 });
    const a = request();
    await service.admit(a);
    advance(leaseMs + 1);
    expect((await service.admit(request())).admitted).toBe(true);
    expect(await service.admit(a)).toMatchObject({ reason: 'segment_cap' });
    await service.release(
      (
        await sql<
          { execution_id: string }[]
        >`select execution_id from admission_reservations where execution_id <> ${a.executionId}`
      )[0].execution_id,
      'succeeded',
    );
    expect(await service.admit(a)).toMatchObject({ admitted: true, replay: false });
    const rows =
      await sql`select 1 from admission_reservations where execution_id = ${a.executionId}`;
    expect(rows).toHaveLength(1);
  });

  test('caps change at runtime without restart; lowering never evicts running work', async () => {
    await service.setLimit('segment', 's1', { maxConcurrent: 2 });
    const held = [request(), request()];
    for (const r of held) await service.admit(r);
    expect(await service.admit(request())).toMatchObject({ reason: 'segment_cap' });
    await service.setLimit('segment', 's1', { maxConcurrent: 4 });
    expect((await service.admit(request())).admitted).toBe(true);
    expect((await service.admit(request())).admitted).toBe(true);
    await service.setLimit('segment', 's1', { maxConcurrent: 1 });
    expect(await service.inFlight('segment', 's1')).toBe(4);
    expect(await service.admit(request())).toMatchObject({ reason: 'segment_cap' });
    await service.removeLimit('segment', 's1');
    expect((await service.admit(request())).admitted).toBe(true);
  });

  test('cost budget follows the owner limit, refunds on cancel and is absent without one', async () => {
    const costly = (cost: number) => request({ estimatedCostMicros: cost });
    expect((await service.admit(costly(10 ** 12))).admitted).toBe(true);
    await service.setLimit('member', 'm1', { maxCostMicros: 100 });
    const a = costly(60);
    expect((await service.admit(a)).admitted).toBe(false);
    await service.removeLimit('member', 'm1');
    await service.setLimit('member', 'm2', { maxCostMicros: 100 });
    const mine = (cost: number) => request({ memberId: 'm2', estimatedCostMicros: cost });
    const first = mine(60);
    expect((await service.admit(first)).admitted).toBe(true);
    expect(await service.admit(mine(60))).toMatchObject({ reason: 'cost_budget' });
    await service.release(first.executionId, 'cancelled');
    expect((await service.admit(mine(60))).admitted).toBe(true);
    const other = request({ memberId: 'm2', windowKey: 'w2', estimatedCostMicros: 100 });
    expect((await service.admit(other)).admitted).toBe(true);
    await service.release(other.executionId, 'succeeded', 30);
    const [row] = await sql<
      { cost_micros: string }[]
    >`select cost_micros::text from admission_reservations where execution_id = ${other.executionId}`;
    expect(row.cost_micros).toBe('30');
  });

  test('provider tokens are paced without holding a lock while the caller waits', async () => {
    await service.setProviderBucket('llm', 2, 1);
    const call = () => request({ provider: 'llm' });
    expect((await service.admit(call())).admitted).toBe(true);
    expect((await service.admit(call())).admitted).toBe(true);
    const denied = await service.admit(call());
    expect(denied).toEqual({ admitted: false, reason: 'provider_throttle', retryAfterMs: 1000 });
    await expect(
      sql.begin((tx) => tx`select 1 from admission_token_buckets for update nowait`),
    ).resolves.toBeDefined();
    const [{ count }] = await sql<
      { count: number }[]
    >`select count(*)::int as count from admission_reservations`;
    expect(count).toBe(2);
    advance(1000);
    expect((await service.admit(call())).admitted).toBe(true);
    await service.setProviderBucket('llm', 1, 1);
    const [bucket] = await sql<{ tokens: number }[]>`select tokens from admission_token_buckets`;
    expect(bucket.tokens).toBeLessThanOrEqual(1);
  });

  test('a suspended scope is denied admission and resumes', async () => {
    const ledger = createMemorySuspensionLedger();
    await publishPins(ledger);
    const guarded = await createAdmissionService({
      sql,
      leaseMs,
      now,
      suspension: createSuspensionEnforcer({ ledger, now: () => testAt }),
    });
    const withContext = (): AdmissionRequest =>
      request({ memberId: 'alice', invocation: testContext });
    expect((await guarded.admit(withContext())).admitted).toBe(true);
    await ledger.change(
      suspendCommand({ scope: 'user', id: 'alice', version: null }),
      'operator',
      testAt,
    );
    const before = await sql`select 1 from admission_reservations`;
    expect(await guarded.admit(withContext())).toEqual({ admitted: false, reason: 'suspended' });
    expect(await sql`select 1 from admission_reservations`).toHaveLength(before.length);
    await expect(guarded.admit(request())).rejects.toThrow(/invocation/);
  });

  test('fairness: a noisy member cannot starve fixture peers under the share policy', async () => {
    const unfair = await simulate(service, sql, undefined);
    const fair = await simulate(service, sql, 5000);
    expect(fair.peerTried).toBe(240);
    expect(fair.noisyTried).toBe(720);
    expect(fair.peerAdmitted).toBe(fair.peerTried);
    expect(fair.noisyAdmitted).toBeGreaterThan(0);
    expect(unfair.peerAdmitted).toBe(0);
  }, 120_000);
});

type Stats = { noisyTried: number; noisyAdmitted: number; peerTried: number; peerAdmitted: number };
async function attempt(svc: AdmissionService, r: AdmissionRequest): Promise<string | undefined> {
  return (await svc.admit(r)).admitted ? r.executionId : undefined;
}
/** Segment of 10 slots; one noisy member tries 12 per tick before 4 peers try 1 each. */
async function simulate(
  svc: AdmissionService,
  db: Sql,
  shareBps: number | undefined,
): Promise<Stats> {
  await db`truncate admission_limits, admission_scopes, admission_reservations`;
  await svc.setLimit('segment', 's1', { maxConcurrent: 10, maxShareBps: shareBps });
  const stats: Stats = { noisyTried: 0, noisyAdmitted: 0, peerTried: 0, peerAdmitted: 0 };
  let peerHeld: string[] = [];
  const noisyWaves: string[][] = [];
  for (let tick = 0; tick < 60; tick += 1) {
    for (const id of peerHeld) await svc.release(id, 'succeeded');
    if (noisyWaves.length >= 3) await releaseAll(svc, noisyWaves.shift() ?? []);
    const wave = await tryMany(svc, 12, (i) => request({ memberId: 'noisy', botId: `bn${i}` }));
    stats.noisyTried += 12;
    stats.noisyAdmitted += wave.length;
    noisyWaves.push(wave);
    const peerCount = 4;
    peerHeld = await tryMany(svc, peerCount, (i) =>
      request({ memberId: `p${i + 1}`, botId: `b-p${i + 1}` }),
    );
    stats.peerTried += peerCount;
    stats.peerAdmitted += peerHeld.length;
  }
  return stats;
}
async function releaseAll(svc: AdmissionService, ids: readonly string[]): Promise<void> {
  for (const id of ids) await svc.release(id, 'succeeded');
}
async function tryMany(
  svc: AdmissionService,
  count: number,
  make: (index: number) => AdmissionRequest,
): Promise<string[]> {
  const admitted: string[] = [];
  for (let i = 0; i < count; i += 1) {
    const id = await attempt(svc, make(i));
    if (id !== undefined) admitted.push(id);
  }
  return admitted;
}
