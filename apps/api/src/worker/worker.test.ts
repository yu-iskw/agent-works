import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest';

import { createServiceIdentityPolicy } from '../auth/service-identity.js';
import { openSql, startDisposablePostgres } from '../ledger/disposable-postgres.js';
import { claimDueWithOutbox } from '../outbox/claim-with-outbox.js';
import { rowClaimReady, switchSchedulerOwner } from '../ports/schedule-row-claim-cutover.js';
import { createRowClaimSchedulePort } from '../ports/schedule-row-claim.js';
import { dockerAvailable, dropSchedulerSchema } from '../ports/schedule-row-claim.testkit.js';
import { createDeliveryHandler } from '../queue/worker-delivery.js';
import { scheduleFixture } from '../scheduling/test-fixtures.js';

import { createPostgresDeliveryStore } from './delivery-store.js';
import { createEffectRunner, resolveEffect } from './effects.js';
import { workerReady } from './migration.js';
import { createExecutionWorker } from './runner.js';
import {
  cancelExecution,
  claimNext,
  commitCheckpoint,
  completeExecution,
  failExecution,
  handoff,
  workerStats,
} from './store.js';
import { sweep } from './sweeper.js';
import { EffectDenied, WorkerFailure } from './types.js';
import {
  at,
  budget,
  digest,
  dropWorkerSchema,
  fakeProvider,
  T0,
  T1,
  allowAll,
} from './worker.testkit.js';

import type { Claim } from './types.js';
import type { DisposablePostgres } from '../ledger/disposable-postgres.js';
import type { RowClaimSchedulePort } from '../ports/schedule-row-claim.js';
import type { Sql } from 'postgres';

const live = dockerAvailable();
const claimInput = { now: T1, limit: 500, owner: 'dispatcher', leaseMs: 30000 };

let database: DisposablePostgres;
let sql: Sql;
let port: RowClaimSchedulePort;
const pools: Sql[] = [];
const pool = () => {
  const p = openSql(database.url);
  pools.push(p);
  return p;
};

beforeAll(async () => {
  if (live) database = await startDisposablePostgres();
}, 60000);
beforeEach(async () => {
  if (!live) return;
  sql = pool();
  await dropSchedulerSchema(sql);
  await dropWorkerSchema(sql);
  await rowClaimReady(sql);
  await switchSchedulerOwner(sql, 'legacy', 'rowclaim');
  await workerReady(sql);
  port = createRowClaimSchedulePort(sql);
});
afterAll(async () => {
  if (!live) return;
  await Promise.all(pools.map((p) => p.end({ timeout: 1 })));
  await database.stop();
});

/** Creates n schedule runs (each with its SCH-02 outbox row) and returns their execution ids. */
async function seedRuns(count: number): Promise<string[]> {
  for (let i = 0; i < count; i += 1) await port.create(scheduleFixture(), 'alice', T0);
  const runs = await claimDueWithOutbox(sql, {}, claimInput);
  return runs.map((r) => r.id);
}
const seedOne = async () => (await seedRuns(1))[0];
const queued = async (): Promise<string> => {
  const id = await seedOne();
  await handoff(sql, { executionId: id, now: T1, budget });
  return id;
};
const claim = async (now = T1, owner = 'w1'): Promise<Claim> => {
  const c = await claimNext(sql, { now, owner, budget });
  if (c === undefined) throw new Error('nothing to claim');
  return c;
};
const row = async (id: string) =>
  (
    await sql<
      {
        state: string;
        fence: number;
        attempts: number;
        checkpoint_version: number;
        checkpoint_ref: string | null;
        last_error_class: string | null;
        quarantine_reason: string | null;
        next_attempt_at: Date;
        max_attempts: number;
      }[]
    >`select state, fence::int, attempts, checkpoint_version, checkpoint_ref, last_error_class, quarantine_reason, next_attempt_at, max_attempts from worker_executions where execution_id = ${id}`
  )[0];
const effectRow = async (key: string) =>
  (
    await sql<
      { state: string; writes: number; resolution: string | null; resolved_by: string | null }[]
    >`select state, writes, resolution, resolved_by from execution_effects where effect_key = ${key}`
  )[0];
const spec = (n = 1) => ({ key: `eff-${n}`, payloadDigest: digest(n), target: 'ticket.create' });
const sweepOpts = (now: string) => ({
  now,
  budget,
  redriveAfterMs: 60_000,
  maxRedrives: 2,
  limit: 100,
});

describe.skipIf(!live)('handoff', () => {
  test('unknown, accepted, repeated, in-progress and terminal outcomes come from the database', async () => {
    const id = await seedOne();
    const ask = (executionId: string, now = T1) => handoff(sql, { executionId, now, budget });
    expect(await ask('f'.repeat(64))).toBe('unknown-execution');
    expect(await ask(id)).toBe('accepted');
    expect(await ask(id)).toBe('accepted');
    expect((await sql`select 1 from worker_executions`).length).toBe(1);
    const c = await claim();
    expect(await ask(id, at(1000))).toBe('in-progress');
    await completeExecution(sql, c, { resultDigest: digest(9), now: at(2000) });
    expect(await ask(id, at(3000))).toBe('already-terminal');
  });

  test('a run already terminal in schedule_runs is acknowledged without creating work', async () => {
    const id = await seedOne();
    await sql.begin(async (tx) => {
      await tx`select set_config('agentworks.scheduler_writer','rowclaim',true)`;
      await tx`update schedule_runs set status = 'cancelled' where id = ${id}`;
    });
    expect(await handoff(sql, { executionId: id, now: T1, budget })).toBe('already-terminal');
    expect((await sql`select 1 from worker_executions`).length).toBe(0);
  });

  test('duplicate and reordered deliveries of one execution never create a second work row', async () => {
    const ids = await seedRuns(2);
    const order = [ids[1], ids[0], ids[1], ids[0], ids[0]];
    const results = await Promise.all(
      order.map((executionId) => handoff(sql, { executionId, now: T1, budget })),
    );
    expect(results.every((r) => r === 'accepted')).toBe(true);
    expect((await sql`select 1 from worker_executions`).length).toBe(2);
  });
});

describe.skipIf(!live)('claiming and fencing', () => {
  test('simultaneous claimers get distinct executions and no execution twice', async () => {
    const ids = await seedRuns(5);
    await Promise.all(ids.map((executionId) => handoff(sql, { executionId, now: T1, budget })));
    const claims = await Promise.all(
      Array.from({ length: 12 }, (_, i) =>
        claimNext(openPool(), { now: T1, owner: `w${i}`, budget }),
      ),
    );
    const won = claims.filter((c): c is Claim => c !== undefined);
    expect(won).toHaveLength(5);
    expect(new Set(won.map((c) => c.executionId)).size).toBe(5);
    expect(won.every((c) => c.fence === 1 && c.attempt === 1)).toBe(true);
  });

  test('an old worker cannot checkpoint, complete or fail after the lease was taken over', async () => {
    const id = await queued();
    const old = await claim(T1, 'old');
    const swept = await sweep(sql, sweepOpts(at(31_000)));
    expect(swept.requeued).toBe(1);
    const fresh = await claim(at(120_000), 'fresh');
    expect(fresh.fence).toBe(old.fence + 1);

    expect(await commitCheckpoint(sql, old, { version: 1, ref: 'old-ref', now: at(121_000) })).toBe(
      'stale',
    );
    expect(
      await failExecution(sql, old, {
        failureClass: 'permanent',
        errorClass: 'x',
        now: at(121_000),
        budget,
      }),
    ).toEqual({ committed: false });
    expect(await completeExecution(sql, old, { resultDigest: digest(1), now: at(121_000) })).toBe(
      'stale',
    );
    const mid = await row(id);
    expect(mid).toMatchObject({ state: 'running', fence: 2, checkpoint_version: 0 });

    expect(
      await commitCheckpoint(sql, fresh, { version: 1, ref: 'new-ref', now: at(122_000) }),
    ).toBe('committed');
    expect(await completeExecution(sql, fresh, { resultDigest: digest(2), now: at(123_000) })).toBe(
      'committed',
    );
    expect(await row(id)).toMatchObject({ state: 'succeeded', checkpoint_ref: 'new-ref' });
  });

  test('a stale worker cannot start a new external effect', async () => {
    await queued();
    const old = await claim(T1, 'old');
    await sweep(sql, sweepOpts(at(31_000)));
    await claim(at(120_000), 'fresh');
    const { remote, provider } = fakeProvider();
    const run = createEffectRunner(sql, allowAll, () => at(121_000));
    await expect(run(old, spec(), provider)).rejects.toMatchObject({ name: 'StaleWorker' });
    expect(remote.calls).toBe(0);
    expect(await effectRow('eff-1')).toBeUndefined();
  });

  test('checkpoint versions advance by one and resume on the next claimant', async () => {
    const id = await queued();
    const c = await claim();
    expect(await commitCheckpoint(sql, c, { version: 2, ref: 'skip', now: T1 })).toBe('stale');
    expect(await commitCheckpoint(sql, c, { version: 1, ref: 'a', now: T1 })).toBe('committed');
    await failExecution(sql, c, { failureClass: 'retryable', errorClass: 'blip', now: T1, budget });
    const next = await claim(at(600_000));
    expect(next).toMatchObject({ checkpointVersion: 1, checkpointRef: 'a', attempt: 2 });
    expect((await row(id)).fence).toBe(2);
  });

  test('cancel wins against a live worker, which then cannot commit', async () => {
    const id = await queued();
    const c = await claim();
    expect(await cancelExecution(sql, { executionId: id, now: at(1000), budget })).toBe(
      'cancelled',
    );
    expect(await completeExecution(sql, c, { resultDigest: digest(1), now: at(2000) })).toBe(
      'stale',
    );
    expect(await handoff(sql, { executionId: id, now: at(3000), budget })).toBe('already-terminal');
    expect(await cancelExecution(sql, { executionId: id, now: at(4000), budget })).toBe(
      'already-terminal',
    );
  });

  test('a terminal row cannot be rewritten even by a direct update', async () => {
    const id = await queued();
    const c = await claim();
    await completeExecution(sql, c, { resultDigest: digest(1), now: T1 });
    await expect(
      sql`update worker_executions set state = 'queued' where execution_id = ${id}`,
    ).rejects.toMatchObject({ code: '55000' });
  });
});

describe.skipIf(!live)('classified retries', () => {
  test('retryable backs off with capped exponential jitter and records the attempt class', async () => {
    const id = await queued();
    const waits: number[] = [];
    for (let i = 1; i <= 3; i += 1) {
      const c = await claim(at(i * 1_000_000));
      const now = at(i * 1_000_000);
      const out = await failExecution(sql, c, {
        failureClass: 'retryable',
        errorClass: 'rate-limited',
        now,
        budget,
      });
      expect(out).toEqual({ committed: true, state: 'queued' });
      waits.push((await row(id)).next_attempt_at.getTime() - Date.parse(now));
    }
    expect(waits).toEqual([7_500, 15_000, 30_000]);
    const attempts = await sql<
      { outcome: string; error_class: string }[]
    >`select outcome, error_class from execution_attempts order by attempt`;
    expect(attempts).toEqual(Array(3).fill({ outcome: 'retryable', error_class: 'rate-limited' }));
  });

  test('a retry is not claimable before its backoff elapses', async () => {
    await queued();
    const c = await claim();
    await failExecution(sql, c, { failureClass: 'retryable', errorClass: 'blip', now: T1, budget });
    expect(await claimNext(sql, { now: at(1000), owner: 'w', budget })).toBeUndefined();
    expect(await claimNext(sql, { now: at(20_000), owner: 'w', budget })).toBeDefined();
  });

  test.each([
    ['permanent', 'failed'],
    ['denied', 'denied'],
  ] as const)(
    '%s is persisted as %s and the transport is told to stop',
    async (failureClass, state) => {
      const id = await queued();
      const c = await claim();
      expect(
        await failExecution(sql, c, { failureClass, errorClass: 'bad-input', now: T1, budget }),
      ).toEqual({ committed: true, state });
      expect(await handoff(sql, { executionId: id, now: at(5000), budget })).toBe(
        'already-terminal',
      );
      expect(await claimNext(sql, { now: at(9_999_999), owner: 'w', budget })).toBeUndefined();
    },
  );

  test('exhausted attempts quarantine visibly in the database and stop looping', async () => {
    const id = await queued();
    for (let i = 1; i <= 4; i += 1) {
      const c = await claim(at(i * 100_000));
      await failExecution(sql, c, {
        failureClass: 'retryable',
        errorClass: 'poison',
        now: at(i * 100_000),
        budget,
      });
    }
    expect(await row(id)).toMatchObject({
      state: 'quarantined',
      quarantine_reason: 'retry-exhausted',
      attempts: 4,
      last_error_class: 'poison',
    });
    expect(await handoff(sql, { executionId: id, now: at(9_000_000), budget })).toBe(
      'already-terminal',
    );
    expect(await workerStats(sql, at(9_000_000))).toMatchObject({ quarantined: 1, queued: 0 });
  });

  test('the time budget quarantines even with attempts left', async () => {
    const id = await queued();
    const c = await claim(at(3_595_000));
    await failExecution(sql, c, {
      failureClass: 'retryable',
      errorClass: 'slow',
      now: at(3_595_000),
      budget,
    });
    expect(await row(id)).toMatchObject({
      state: 'quarantined',
      quarantine_reason: 'time-budget',
      attempts: 1,
    });
  });

  test('an unclassified handler error is retryable, a poison handler ends quarantined', async () => {
    const id = await queued();
    let t = 0;
    const worker = createExecutionWorker({
      sql,
      owner: 'w',
      budget,
      gate: allowAll,
      handler: () => Promise.reject(new Error('secret provider text')),
      now: () => at(t),
    });
    const states: string[] = [];
    for (let i = 1; i <= 5; i += 1) {
      t = i * 100_000;
      const out = await worker.runOnce();
      if (out.kind === 'ran') states.push(out.state);
    }
    expect(states).toEqual(['queued', 'queued', 'queued', 'quarantined']);
    expect((await row(id)).last_error_class).toBe('unknown');
  });
});

describe.skipIf(!live)('effect ledger', () => {
  const runner = (now = T1) => createEffectRunner(sql, allowAll, () => now);

  test('a write that succeeds is recorded once and never repeated by a retry or takeover', async () => {
    await queued();
    const c = await claim();
    const { remote, provider } = fakeProvider();
    expect(await runner()(c, spec(), provider)).toEqual({ kind: 'done', source: 'written' });
    expect(await runner()(c, spec(), provider)).toEqual({ kind: 'done', source: 'recorded' });
    expect(remote).toEqual({ applied: 1, calls: 1 });
    expect(await effectRow('eff-1')).toMatchObject({ state: 'succeeded', writes: 1 });
  });

  test('a write that succeeded but lost its response is uncertain and is not replayed on retry', async () => {
    const id = await queued();
    const c = await claim();
    const { remote, provider } = fakeProvider('ack-lost');
    expect(await runner()(c, spec(), provider)).toEqual({ kind: 'uncertain' });
    expect(await effectRow('eff-1')).toMatchObject({ state: 'uncertain' });

    // Retry after uncertain, same worker and then a later attempt: the provider write is not called again.
    expect(await runner()(c, spec(), provider)).toEqual({ kind: 'uncertain' });
    await failExecution(sql, c, {
      failureClass: 'uncertain',
      errorClass: 'effect-uncertain',
      now: T1,
      budget,
    });
    expect((await row(id)).state).toBe('awaiting-reconciliation');
    expect(await claimNext(sql, { now: at(9_000_000), owner: 'w2', budget })).toBeUndefined();
    expect(remote).toEqual({ applied: 1, calls: 1 });
  });

  test('read-back that finds the write applied reconciles without writing', async () => {
    await queued();
    const c = await claim();
    await runner()(c, spec(), fakeProvider('ack-lost').provider);
    const { remote, provider } = fakeProvider('ok', () => Promise.resolve('applied'));
    expect(await runner()(c, spec(), provider)).toEqual({ kind: 'done', source: 'read-back' });
    expect(remote.calls).toBe(0);
    expect(await effectRow('eff-1')).toMatchObject({
      state: 'reconciled',
      resolution: 'applied',
      resolved_by: 'read-back',
    });
  });

  test('read-back that proves it was not applied allows exactly one new write', async () => {
    await queued();
    const c = await claim();
    await runner()(c, spec(), fakeProvider('ack-lost').provider);
    const { remote, provider } = fakeProvider('ok', () => Promise.resolve('not-applied'));
    expect(await runner()(c, spec(), provider)).toEqual({ kind: 'done', source: 'written' });
    expect(remote).toEqual({ applied: 1, calls: 1 });
    expect(await effectRow('eff-1')).toMatchObject({ state: 'succeeded', writes: 2 });
  });

  test('inconclusive or failing read-back keeps the effect uncertain', async () => {
    await queued();
    const c = await claim();
    await runner()(c, spec(), fakeProvider('ack-lost').provider);
    for (const readBack of [
      () => Promise.resolve('unknown' as const),
      () => Promise.reject(new Error('down')),
    ]) {
      const { remote, provider } = fakeProvider('ok', readBack);
      expect(await runner()(c, spec(), provider)).toEqual({ kind: 'uncertain' });
      expect(remote.calls).toBe(0);
    }
  });

  test.each([
    ['applied', 0],
    ['not-applied', 1],
  ] as const)(
    'manual resolution %s requeues the parked execution and the write count is %i',
    async (resolution, writes) => {
      const id = await queued();
      let holder = fakeProvider('ack-lost');
      const worker = createExecutionWorker({
        sql,
        owner: 'w',
        budget,
        gate: allowAll,
        now: () => T1,
        handler: async (ctx) => {
          await ctx.effect(spec(), holder.provider);
          return { resultDigest: digest(7) };
        },
      });
      expect(await worker.runOnce()).toMatchObject({
        kind: 'ran',
        state: 'awaiting-reconciliation',
      });
      expect(
        await resolveEffect(sql, {
          effectKey: 'eff-1',
          resolution,
          resolvedBy: 'ops@example.test',
          evidenceRef: 'ticket-1',
          now: at(1000),
        }),
      ).toBe('resolved');
      expect(
        await resolveEffect(sql, {
          effectKey: 'eff-1',
          resolution,
          resolvedBy: 'ops@example.test',
          evidenceRef: null,
          now: at(1000),
        }),
      ).toBe('not-uncertain');
      expect((await row(id)).state).toBe('queued');
      holder = fakeProvider('ok');
      const later = createExecutionWorker({
        sql,
        owner: 'w',
        budget,
        gate: allowAll,
        now: () => at(2000),
        handler: async (ctx) => {
          await ctx.effect(spec(), holder.provider);
          return { resultDigest: digest(7) };
        },
      });
      expect(await later.runOnce()).toMatchObject({ kind: 'ran', state: 'succeeded' });
      expect(holder.remote.calls).toBe(writes);
      expect(await effectRow('eff-1')).toMatchObject({ resolved_by: 'ops@example.test' });
    },
  );

  test('worker death after the call began: lease expiry makes the pending effect uncertain, not replayable', async () => {
    const id = await queued();
    const never = { write: () => new Promise<never>(() => undefined) };
    const dying = createExecutionWorker({
      sql,
      owner: 'dying',
      budget,
      gate: allowAll,
      now: () => T1,
      handler: async (ctx) => {
        await ctx.effect(spec(), never);
        return { resultDigest: digest(1) };
      },
    });
    void dying.runOnce();
    await vi_waitFor(
      async () => (await sql`select 1 from execution_effects where state = 'pending'`).length === 1,
    );
    expect(await sweep(sql, sweepOpts(at(31_000)))).toMatchObject({
      awaitingReconciliation: 1,
      requeued: 0,
    });
    expect(await effectRow('eff-1')).toMatchObject({ state: 'uncertain' });
    expect((await row(id)).state).toBe('awaiting-reconciliation');
    expect(await claimNext(sql, { now: at(9_000_000), owner: 'next', budget })).toBeUndefined();
  });

  test('worker death before any effect: the takeover performs the effect exactly once', async () => {
    const id = await queued();
    await claim(T1, 'dead');
    expect(await sweep(sql, sweepOpts(at(31_000)))).toMatchObject({ requeued: 1 });
    const { remote, provider } = fakeProvider();
    const worker = createExecutionWorker({
      sql,
      owner: 'next',
      budget,
      gate: allowAll,
      now: () => at(600_000),
      handler: async (ctx) => {
        await ctx.effect(spec(), provider);
        return { resultDigest: digest(3) };
      },
    });
    expect(await worker.runOnce()).toMatchObject({ kind: 'ran', state: 'succeeded' });
    expect(remote).toEqual({ applied: 1, calls: 1 });
    expect((await row(id)).attempts).toBe(2);
  });

  test('the same key with a changed payload or target is refused and never reaches the provider', async () => {
    await queued();
    const c = await claim();
    const { remote, provider } = fakeProvider();
    await runner()(c, spec(), provider);
    await expect(
      runner()(c, { ...spec(), payloadDigest: digest(99) }, provider),
    ).rejects.toMatchObject({ name: 'EffectKeyConflict' });
    await expect(
      runner()(c, { ...spec(), target: 'ticket.delete' }, provider),
    ).rejects.toMatchObject({ name: 'EffectKeyConflict' });
    expect(remote.calls).toBe(1);
  });

  test('a definite provider rejection is failed-safe-to-retry and may be written again', async () => {
    await queued();
    const c = await claim();
    const rejected = fakeProvider('rejected');
    await expect(runner()(c, spec(), rejected.provider)).rejects.toMatchObject({
      name: 'EffectNotApplied',
    });
    expect(await effectRow('eff-1')).toMatchObject({ state: 'failed' });
    const ok = fakeProvider();
    expect(await runner()(c, spec(), ok.provider)).toEqual({ kind: 'done', source: 'written' });
    expect(await effectRow('eff-1')).toMatchObject({ state: 'succeeded', writes: 2 });
  });
});

describe.skipIf(!live)('authority recheck before each effect', () => {
  test('a denial stops the effect before a pending row exists and ends the execution as denied', async () => {
    const id = await queued();
    let revoked = false;
    const gate = {
      check: () =>
        revoked ? Promise.reject(new EffectDenied('authority-denied')) : Promise.resolve(),
    };
    const { remote, provider } = fakeProvider();
    const worker = createExecutionWorker({
      sql,
      owner: 'w',
      budget,
      gate,
      now: () => T1,
      handler: async (ctx) => {
        await ctx.effect(spec(1), provider);
        revoked = true;
        await ctx.effect(spec(2), provider);
        return { resultDigest: digest(1) };
      },
    });
    expect(await worker.runOnce()).toMatchObject({ kind: 'ran', state: 'denied' });
    expect(remote.calls).toBe(1);
    expect(await effectRow('eff-2')).toBeUndefined();
    expect(await handoff(sql, { executionId: id, now: at(5000), budget })).toBe('already-terminal');
  });

  test('an unavailable authority store fails closed and retryable', async () => {
    const id = await queued();
    const { remote, provider } = fakeProvider();
    const worker = createExecutionWorker({
      sql,
      owner: 'w',
      budget,
      now: () => T1,
      gate: {
        check: () => Promise.reject(new WorkerFailure('retryable', 'authority-unavailable')),
      },
      handler: async (ctx) => {
        await ctx.effect(spec(), provider);
        return { resultDigest: digest(1) };
      },
    });
    expect(await worker.runOnce()).toMatchObject({ state: 'queued' });
    expect(remote.calls).toBe(0);
    expect((await row(id)).last_error_class).toBe('authority-unavailable');
  });
});

describe.skipIf(!live)('sweeper and queue loss', () => {
  test('lease expiry past the attempt budget quarantines instead of requeueing', async () => {
    const id = await queued();
    await sql`update worker_executions set max_attempts = 1 where execution_id = ${id}`;
    await claim();
    expect(await sweep(sql, sweepOpts(at(31_000)))).toMatchObject({ quarantined: 1, requeued: 0 });
    expect(await row(id)).toMatchObject({
      state: 'quarantined',
      quarantine_reason: 'retry-exhausted',
    });
  });

  test('a published dispatch with no work row is re-enqueued once, then bounded', async () => {
    const [id] = await seedRuns(1);
    await sql`update dispatch_outbox set state = 'published', published_at = ${T1} where execution_id = ${id}`;
    expect(await sweep(sql, sweepOpts(at(30_000)))).toMatchObject({ redriven: 0 });
    expect(await sweep(sql, sweepOpts(at(61_000)))).toMatchObject({ redriven: 1 });
    expect(await sweep(sql, sweepOpts(at(62_000)))).toMatchObject({ redriven: 0 });
    const rows = await sql<
      { dispatch_id: string; state: string }[]
    >`select dispatch_id, state from dispatch_outbox order by dispatch_id`;
    expect(rows.map((r) => r.state)).toEqual(['published', 'pending']);
    expect(rows[1].dispatch_id).toBe(`${rows[0].dispatch_id}:r1`);

    for (let i = 2; i <= 3; i += 1) {
      await sql`update dispatch_outbox set state = 'published', published_at = ${at(60_000 * i)} where execution_id = ${id} and state = 'pending'`;
      await sweep(sql, sweepOpts(at(60_000 * i + 61_000)));
    }
    expect(await row(id)).toMatchObject({
      state: 'quarantined',
      quarantine_reason: 'redrive-exhausted',
    });
  });

  test('an execution that already has a work row is never re-enqueued', async () => {
    const id = await queued();
    await sql`update dispatch_outbox set state = 'published', published_at = ${T1} where execution_id = ${id}`;
    expect(await sweep(sql, sweepOpts(at(600_000)))).toMatchObject({ redriven: 0 });
    expect((await sql`select 1 from dispatch_outbox`).length).toBe(1);
  });

  test('queue message loss end to end: lost message, sweep, republish, handoff, run', async () => {
    const [id] = await seedRuns(1);
    await sql`update dispatch_outbox set state = 'published', published_at = ${T1} where execution_id = ${id}`;
    await sweep(sql, sweepOpts(at(61_000)));
    const [fresh] = await sql<
      { envelope: { executionId: string } }[]
    >`select envelope from dispatch_outbox where state = 'pending'`;
    expect(
      await handoff(sql, { executionId: fresh.envelope.executionId, now: at(62_000), budget }),
    ).toBe('accepted');
    const worker = createExecutionWorker({
      sql,
      owner: 'w',
      budget,
      gate: allowAll,
      now: () => at(63_000),
      handler: () => Promise.resolve({ resultDigest: digest(5) }),
    });
    expect(await worker.runOnce()).toMatchObject({ kind: 'ran', state: 'succeeded' });
  });

  test('only one pending outbox row per execution can exist', async () => {
    const [id] = await seedRuns(1);
    await expect(
      sql`insert into dispatch_outbox(dispatch_id, execution_id, target_kind, transport_name, envelope, state, next_attempt_at, created_at)
        values('dsp:other', ${id}, 'cloud-tasks-http', ${'d-' + 'a'.repeat(64)}, '{}'::jsonb, 'pending', ${T1}, ${T1})`,
    ).rejects.toMatchObject({ code: '23505' });
  });
});

describe.skipIf(!live)('delivery handler over the Postgres store', () => {
  const nowMs = Date.parse(T1);
  const audience = 'https://worker.example.test/internal/deliveries';
  const email = 'aw-dispatcher@aw-dev.iam.gserviceaccount.com';
  const handler = () =>
    createDeliveryHandler({
      verifyIdToken: () =>
        Promise.resolve({
          iss: 'https://accounts.google.com',
          aud: audience,
          sub: 'sa-1',
          email,
          email_verified: true,
          iat: nowMs / 1000 - 10,
          exp: nowMs / 1000 + 600,
        }),
      policy: createServiceIdentityPolicy({ audience, authorizedEmails: [email] }),
      store: createPostgresDeliveryStore(sql, { budget, now: () => new Date(nowMs) }),
      now: () => nowMs,
    });
  const deliver = (body: string) => handler()({ authorization: 'Bearer t', body });
  const envelope = (executionId: string) =>
    JSON.stringify({ schemaVersion: 1, executionId, dispatchId: `dsp:${executionId}` });

  test('poison is recorded then acknowledged, unknown retries, accepted work finishes and then acks as terminal', async () => {
    const id = await seedOne();
    expect(await deliver('{not json')).toEqual({ status: 200, outcome: 'rejected:malformed' });
    expect(await sql`select reason, caller_sub from delivery_rejections`).toEqual([
      { reason: 'malformed', caller_sub: 'sa-1' },
    ]);
    expect((await deliver(envelope('e'.repeat(64)))).status).toBe(503);
    expect(await deliver(envelope(id))).toEqual({ status: 200, outcome: 'accepted' });
    expect(await deliver(envelope(id))).toEqual({ status: 200, outcome: 'accepted' });
    const worker = createExecutionWorker({
      sql,
      owner: 'w',
      budget,
      gate: allowAll,
      now: () => T1,
      handler: () => Promise.resolve({ resultDigest: digest(4) }),
    });
    expect(await worker.runOnce()).toMatchObject({ state: 'succeeded' });
    expect(await deliver(envelope(id))).toEqual({ status: 200, outcome: 'already-terminal' });
  });

  test('a denied execution is acknowledged so the queue stops redelivering it', async () => {
    const id = await seedOne();
    await deliver(envelope(id));
    const worker = createExecutionWorker({
      sql,
      owner: 'w',
      budget,
      gate: allowAll,
      now: () => T1,
      handler: () => Promise.reject(new EffectDenied('authority-denied')),
    });
    expect(await worker.runOnce()).toMatchObject({ state: 'denied' });
    expect(await deliver(envelope(id))).toEqual({ status: 200, outcome: 'already-terminal' });
  });
});

const extra: Sql[] = [];
function openPool(): Sql {
  const p = openSql(database.url);
  extra.push(p);
  pools.push(p);
  return p;
}

async function vi_waitFor(check: () => Promise<boolean>): Promise<void> {
  for (let i = 0; i < 100; i += 1) {
    if (await check()) return;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error('condition not reached');
}
