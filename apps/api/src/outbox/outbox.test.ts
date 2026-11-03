import {
  dispatchTransportName,
  outboxRecordSchema,
  readDispatchEnvelope,
  scheduleRunId,
} from '@agent-works/domain';
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest';

import { openSql, startDisposablePostgres } from '../ledger/disposable-postgres.js';
import { rowClaimReady, switchSchedulerOwner } from '../ports/schedule-row-claim-cutover.js';
import { createRowClaimSchedulePort } from '../ports/schedule-row-claim.js';
import { dockerAvailable, dropSchedulerSchema } from '../ports/schedule-row-claim.testkit.js';
import { scheduleFixture } from '../scheduling/test-fixtures.js';

import { claimDueWithOutbox } from './claim-with-outbox.js';
import { outboxReady } from './migration.js';
import { createMemoryQueue, dropOutboxSchema } from './outbox.testkit.js';
import { createOutboxPublisher, QueuePublishError } from './publisher.js';
import {
  claimBatch,
  dispatchIdFor,
  markFailed,
  markPublished,
  outboxStats,
  reconcileLeases,
} from './store.js';

import type { PublisherOptions, QueuePublisher } from './publisher.js';
import type { DisposablePostgres } from '../ledger/disposable-postgres.js';
import type { RowClaimSchedulePort } from '../ports/schedule-row-claim.js';
import type { Sql } from 'postgres';

const live = dockerAvailable();
const T0 = '2026-10-14T10:00:00.000Z';
const T1 = '2026-10-14T10:01:00.000Z';
const at = (ms: number) => new Date(Date.parse(T1) + ms).toISOString();
const claimInput = { now: T1, limit: 500, owner: 'dispatcher', leaseMs: 30000 };
const publisherOptions = (owner: string): PublisherOptions => ({
  owner,
  leaseMs: 30000,
  maxAttempts: 4,
  baseBackoffMs: 1000,
  maxBackoffMs: 60000,
  random: () => 0.5,
});

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
  await dropOutboxSchema(sql);
  await rowClaimReady(sql);
  await switchSchedulerOwner(sql, 'legacy', 'rowclaim');
  await outboxReady(sql);
  port = createRowClaimSchedulePort(sql);
});
afterAll(async () => {
  if (!live) return;
  await Promise.all(pools.map((p) => p.end({ timeout: 1 })));
  await database.stop();
});

async function seed(count: number): Promise<string[]> {
  const ids: string[] = [];
  for (let i = 0; i < count; i += 1) {
    const spec = scheduleFixture();
    await port.create(spec, 'alice', T0);
    ids.push(spec.id);
  }
  return ids;
}
const outboxRows = () =>
  sql<
    {
      dispatch_id: string;
      execution_id: string;
      state: string;
      attempts: number;
      next_attempt_at: Date;
      last_error_class: string | null;
      published_at: Date | null;
      lease_owner: string | null;
    }[]
  >`select dispatch_id, execution_id, state, attempts, next_attempt_at, last_error_class, published_at, lease_owner from dispatch_outbox order by dispatch_id`;
const runCount = async () =>
  (await sql<{ n: number }[]>`select count(*)::int as n from schedule_runs`)[0].n;

describe.skipIf(!live)('run and outbox commit in the claim transaction', () => {
  test('one claim writes the run, the cursor advance and a contract-valid outbox row', async () => {
    const [id] = await seed(1);
    const runs = await claimDueWithOutbox(sql, {}, claimInput);
    expect(runs).toHaveLength(1);
    const executionId = scheduleRunId(id, T1);
    const rows = await sql<
      Record<string, unknown>[]
    >`select * from dispatch_outbox where execution_id = ${executionId}`;
    expect(rows).toHaveLength(1);
    const row = rows[0];
    const record = outboxRecordSchema.parse({
      dispatchId: row.dispatch_id,
      executionId: row.execution_id,
      targetKind: row.target_kind,
      transportName: row.transport_name,
      envelope: row.envelope,
      state: row.state,
      attempts: row.attempts,
      nextAttemptAt: (row.next_attempt_at as Date).toISOString(),
      leaseOwner: row.lease_owner,
      leaseUntil: null,
      lastErrorClass: row.last_error_class,
      createdAt: (row.created_at as Date).toISOString(),
      publishedAt: null,
    });
    expect(record.dispatchId).toBe(dispatchIdFor(executionId));
    expect(record.transportName).toBe(dispatchTransportName(record.dispatchId));
    expect((await port.read('alice', id))?.cursor).toBe(T1);
    expect(await claimDueWithOutbox(sql, {}, { ...claimInput, now: T1 })).toEqual([]);
    expect(await outboxRows()).toHaveLength(1);
  });

  test('an outbox failure rolls back the run and the cursor, and the slot is claimable later', async () => {
    const [id] = await seed(1);
    const executionId = scheduleRunId(id, T1);
    await sql`insert into dispatch_outbox(dispatch_id, execution_id, target_kind, transport_name, envelope, next_attempt_at, created_at)
      values('dsp:conflict', ${executionId}, 'cloud-tasks-http', ${dispatchTransportName('dsp:conflict')}, '{}'::jsonb, ${T1}, ${T1})`;
    await expect(claimDueWithOutbox(sql, {}, claimInput)).rejects.toMatchObject({ code: '23505' });
    expect(await runCount()).toBe(0);
    expect((await port.read('alice', id))?.cursor).toBe(T0);
    await sql`delete from dispatch_outbox`;
    expect(await claimDueWithOutbox(sql, {}, claimInput)).toHaveLength(1);
    expect(await runCount()).toBe(1);
    expect(await outboxRows()).toHaveLength(1);
  });

  test('the database refuses a malformed identity and a second live chain for one occurrence', async () => {
    const [id] = await seed(1);
    await claimDueWithOutbox(sql, {}, claimInput);
    const executionId = scheduleRunId(id, T1);
    await expect(
      sql`insert into dispatch_outbox(dispatch_id, execution_id, target_kind, transport_name, envelope, next_attempt_at, created_at)
        values('dsp:second', ${executionId}, 'cloud-tasks-http', ${dispatchTransportName('dsp:second')}, '{}'::jsonb, ${T1}, ${T1})`,
    ).rejects.toMatchObject({ code: '23505' });
    await expect(
      sql`insert into dispatch_outbox(dispatch_id, execution_id, target_kind, transport_name, envelope, next_attempt_at, created_at)
        values('dsp:x', 'other', 'cloud-tasks-http', 'not-a-transport-name', '{}'::jsonb, ${T1}, ${T1})`,
    ).rejects.toMatchObject({ code: '23514' });
  });
});

describe.skipIf(!live)('publishing after commit', () => {
  test('a crash after commit and before publish still publishes later', async () => {
    const ids = await seed(3);
    await claimDueWithOutbox(sql, {}, claimInput);
    expect((await outboxRows()).map((r) => r.state)).toEqual(['pending', 'pending', 'pending']);
    const memory = createMemoryQueue();
    const later = createOutboxPublisher(pool(), memory.queue, publisherOptions('after-restart'));
    const report = await later.publishBatch({ now: at(5 * 60_000), limit: 10 });
    expect(report.published).toBe(3);
    expect(memory.accepted.size).toBe(3);
    expect((await outboxRows()).every((r) => r.state === 'published')).toBe(true);
    expect(await runCount()).toBe(ids.length);
  });

  test('messages carry the stable transport name and a valid v1 envelope', async () => {
    const [id] = await seed(1);
    await claimDueWithOutbox(sql, {}, claimInput);
    const seen: { name: string; body: string; dispatchId: string }[] = [];
    const queue: QueuePublisher = {
      publish: (m) => {
        seen.push({ name: m.transportName, body: m.body, dispatchId: m.dispatchId });
        return Promise.resolve('created');
      },
    };
    await createOutboxPublisher(sql, queue, publisherOptions('p')).publishBatch({
      now: T1,
      limit: 5,
    });
    const executionId = scheduleRunId(id, T1);
    expect(seen).toHaveLength(1);
    expect(seen[0].name).toBe(dispatchTransportName(dispatchIdFor(executionId)));
    expect(readDispatchEnvelope(seen[0].body)).toEqual({
      ok: true,
      envelope: { schemaVersion: 1, executionId, dispatchId: dispatchIdFor(executionId) },
    });
  });

  test('no transaction or row lock is held while the queue call is in flight', async () => {
    await seed(1);
    await claimDueWithOutbox(sql, {}, claimInput);
    const probe = pool();
    let lockedDuringPublish: boolean | undefined;
    const queue: QueuePublisher = {
      async publish() {
        const idle = await probe`select count(*)::int as n from pg_stat_activity
          where datname = current_database() and state = 'idle in transaction'`;
        const row = await probe.begin(async (tx) => {
          await tx`set local lock_timeout = '200ms'`;
          return tx`select dispatch_id from dispatch_outbox for update nowait`;
        });
        lockedDuringPublish = idle[0].n > 0 || row.length !== 1;
        return 'created';
      },
    };
    await createOutboxPublisher(sql, queue, publisherOptions('p')).publishBatch({
      now: T1,
      limit: 5,
    });
    expect(lockedDuringPublish).toBe(false);
  });
});

describe.skipIf(!live)('lost enqueue acknowledgement', () => {
  test('retries under the same transport name and never creates a second logical run', async () => {
    const [id] = await seed(1);
    await claimDueWithOutbox(sql, {}, claimInput);
    const memory = createMemoryQueue((_m, call) => (call === 1 ? 'ack-lost' : 'ok'));
    const publisher = createOutboxPublisher(sql, memory.queue, publisherOptions('p'));
    const first = await publisher.publishBatch({ now: T1, limit: 5 });
    expect(first).toMatchObject({ published: 0, retried: 1 });
    const [pending] = await outboxRows();
    expect(pending).toMatchObject({ state: 'pending', attempts: 1, last_error_class: 'unknown' });
    expect(pending.next_attempt_at.toISOString()).toBe(at(750));
    expect(await publisher.publishBatch({ now: T1, limit: 5 })).toMatchObject({ published: 0 });
    const second = await publisher.publishBatch({ now: at(750), limit: 5 });
    expect(second.published).toBe(1);
    expect(memory.calls).toBe(2);
    expect([...memory.accepted.values()]).toEqual([2]);
    expect(memory.accepted.size).toBe(1);
    const [done] = await outboxRows();
    expect(done).toMatchObject({ state: 'published', attempts: 2, last_error_class: null });
    expect(await runCount()).toBe(1);
    expect(await claimDueWithOutbox(sql, {}, { ...claimInput, now: at(30_000) })).toEqual([]);
    expect(await outboxRows()).toHaveLength(1);
    expect((await port.runs(id)).map((r) => r.id)).toEqual([scheduleRunId(id, T1)]);
  });

  test('a queue without name dedupe still yields one run and one outbox row', async () => {
    await seed(1);
    await claimDueWithOutbox(sql, {}, claimInput);
    const names: string[] = [];
    let call = 0;
    const queue: QueuePublisher = {
      publish: (m) => {
        names.push(m.transportName);
        call += 1;
        return call === 1
          ? Promise.reject(new Error('ack lost'))
          : Promise.resolve<'created'>('created');
      },
    };
    const publisher = createOutboxPublisher(sql, queue, publisherOptions('p'));
    await publisher.publishBatch({ now: T1, limit: 5 });
    await publisher.publishBatch({ now: at(750), limit: 5 });
    expect(names).toHaveLength(2);
    expect(new Set(names).size).toBe(1);
    expect(await runCount()).toBe(1);
    expect(await outboxRows()).toHaveLength(1);
  });
});

describe.skipIf(!live)('concurrent publishers', () => {
  test.each([4, 6])(
    '%i publishers publish every event, run uniqueness holds',
    async (n) => {
      const events = 40;
      await seed(events);
      await claimDueWithOutbox(sql, {}, claimInput);
      const memory = createMemoryQueue(async () => {
        await new Promise((resolve) => setTimeout(resolve, 2));
        return 'ok' as const;
      });
      await Promise.all(
        Array.from({ length: n }, async (_, i) => {
          const publisher = createOutboxPublisher(pool(), memory.queue, publisherOptions(`p${i}`));
          for (;;) {
            const r = await publisher.publishBatch({ now: T1, limit: 3 });
            if (r.published + r.retried + r.abandoned + r.superseded === 0) break;
          }
        }),
      );
      const rows = await outboxRows();
      expect(rows).toHaveLength(events);
      expect(rows.every((r) => r.state === 'published')).toBe(true);
      expect(memory.accepted.size).toBe(events);
      expect([...memory.accepted.values()].every((c) => c >= 1)).toBe(true);
      expect(memory.calls).toBe(events);
      expect(await runCount()).toBe(events);
      expect(new Set(rows.map((r) => r.execution_id)).size).toBe(events);
    },
    60000,
  );
});

describe.skipIf(!live)('stale lease recovery and fencing', () => {
  const claimArgs = (owner: string, now: string, leaseMs = 1000) => ({
    now,
    limit: 5,
    owner,
    leaseMs,
    maxAttempts: 4,
  });
  const failure = (now: string) => ({
    now,
    errorClass: 'late-failure',
    retryable: true,
    retryAt: now,
    maxAttempts: 4,
  });

  test('a publisher that dies mid-publish is recovered after its lease expires', async () => {
    await seed(1);
    await claimDueWithOutbox(sql, {}, claimInput);
    const [dead] = await claimBatch(sql, claimArgs('dead', T1));
    expect(dead).toMatchObject({ fence: 1, attempts: 1 });
    expect(await claimBatch(sql, claimArgs('other', at(500)))).toEqual([]);
    const memory = createMemoryQueue();
    const live2 = createOutboxPublisher(sql, memory.queue, publisherOptions('live'));
    expect((await live2.publishBatch({ now: at(500), limit: 5 })).published).toBe(0);
    const report = await live2.publishBatch({ now: at(2000), limit: 5 });
    expect(report.published).toBe(1);
    const [row] = await outboxRows();
    expect(row).toMatchObject({ state: 'published', attempts: 2, lease_owner: null });
  });

  test('reconcile clears expired leases visibly and quarantines exhausted ones', async () => {
    await seed(2);
    await claimDueWithOutbox(sql, {}, claimInput);
    const [a, b] = await claimBatch(sql, claimArgs('dead', T1));
    await sql`update dispatch_outbox set attempts = 4 where dispatch_id = ${b.dispatchId}`;
    expect(await reconcileLeases(sql, { now: at(500), maxAttempts: 4 })).toEqual({
      released: 0,
      abandoned: 0,
    });
    expect(await reconcileLeases(sql, { now: at(2000), maxAttempts: 4 })).toEqual({
      released: 1,
      abandoned: 1,
    });
    const rows = await outboxRows();
    const byId = new Map(rows.map((r) => [r.dispatch_id, r]));
    expect(byId.get(a.dispatchId)).toMatchObject({
      state: 'pending',
      last_error_class: 'lease-expired',
      lease_owner: null,
    });
    expect(byId.get(b.dispatchId)).toMatchObject({
      state: 'abandoned',
      last_error_class: 'lease-expired',
    });
    expect(await outboxStats(sql, at(2000))).toMatchObject({ pending: 1, abandoned: 1 });
  });

  test('a stale publisher cannot overwrite a terminal state', async () => {
    await seed(1);
    await claimDueWithOutbox(sql, {}, claimInput);
    const [stale] = await claimBatch(sql, claimArgs('stale', T1));
    const [fresh] = await claimBatch(sql, claimArgs('fresh', at(2000)));
    expect(fresh.fence).toBe(stale.fence + 1);
    expect(await markPublished(sql, fresh, at(2100))).toBe(true);
    expect(await markPublished(sql, stale, at(9000))).toBe(false);
    expect(await markFailed(sql, stale, failure(at(9000)))).toBe('superseded');
    const [row] = await outboxRows();
    expect(row.state).toBe('published');
    expect(row.published_at?.toISOString()).toBe(at(2100));
    expect(row.last_error_class).toBeNull();
    await expect(
      sql`update dispatch_outbox set state = 'pending', published_at = null`,
    ).rejects.toMatchObject({ code: '55000' });
  });

  test('a stale holder cannot complete or fail a row that a newer lease still holds', async () => {
    await seed(1);
    await claimDueWithOutbox(sql, {}, claimInput);
    const [stale] = await claimBatch(sql, claimArgs('stale', T1));
    const [fresh] = await claimBatch(sql, claimArgs('fresh', at(2000), 60_000));
    expect(await markPublished(sql, stale, at(2500))).toBe(false);
    expect(await markFailed(sql, stale, failure(at(2500)))).toBe('superseded');
    expect((await outboxRows())[0]).toMatchObject({ state: 'pending', lease_owner: 'fresh' });
    expect(await markPublished(sql, fresh, at(3000))).toBe(true);
  });

  test('a stale failure cannot revive or re-lease a row a newer holder abandoned', async () => {
    await seed(1);
    await claimDueWithOutbox(sql, {}, claimInput);
    const [stale] = await claimBatch(sql, claimArgs('stale', T1));
    const [fresh] = await claimBatch(sql, claimArgs('fresh', at(2000)));
    expect(await markFailed(sql, fresh, { ...failure(at(2100)), retryable: false })).toBe(
      'abandoned',
    );
    expect(await markFailed(sql, stale, failure(at(9000)))).toBe('superseded');
    expect(await markPublished(sql, stale, at(9000))).toBe(false);
    expect((await outboxRows())[0].state).toBe('abandoned');
    expect(await claimBatch(sql, claimArgs('later', at(60_000)))).toEqual([]);
  });
});

describe.skipIf(!live)('poison events', () => {
  test('capped backoff with jitter, then quarantine visible in the table', async () => {
    await seed(2);
    await claimDueWithOutbox(sql, {}, claimInput);
    const poison = new QueuePublishError('http-503', true);
    const memory = createMemoryQueue(() => poison);
    const publisher = createOutboxPublisher(sql, memory.queue, publisherOptions('p'));
    const waits: number[] = [];
    let now = T1;
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      const report = await publisher.publishBatch({ now, limit: 10 });
      expect(report.retried).toBe(2);
      const rows = await outboxRows();
      expect(rows.every((r) => r.attempts === attempt && r.state === 'pending')).toBe(true);
      expect(rows[0].last_error_class).toBe('http-503');
      waits.push(rows[0].next_attempt_at.getTime() - Date.parse(now));
      expect(await publisher.publishBatch({ now, limit: 10 })).toMatchObject({ retried: 0 });
      now = rows[0].next_attempt_at.toISOString();
    }
    expect(waits).toEqual([750, 1500, 3000]);
    const last = await publisher.publishBatch({ now, limit: 10 });
    expect(last).toMatchObject({ abandoned: 2, retried: 0 });
    const rows = await outboxRows();
    expect(rows.map((r) => [r.state, r.attempts, r.last_error_class])).toEqual([
      ['abandoned', 4, 'http-503'],
      ['abandoned', 4, 'http-503'],
    ]);
    const calls = memory.calls;
    expect(await publisher.publishBatch({ now: at(86_400_000), limit: 10 })).toMatchObject({
      abandoned: 0,
      published: 0,
    });
    expect(memory.calls).toBe(calls);
    expect(await outboxStats(sql, at(86_400_000))).toMatchObject({ abandoned: 2, pending: 0 });
  });

  test('a non-retryable failure is quarantined at once and raw provider text is never stored', async () => {
    await seed(1);
    await claimDueWithOutbox(sql, {}, claimInput);
    const memory = createMemoryQueue(
      () => new QueuePublishError('Bad Class: secret-token abc', false),
    );
    const report = await createOutboxPublisher(
      sql,
      memory.queue,
      publisherOptions('p'),
    ).publishBatch({ now: T1, limit: 5 });
    expect(report.abandoned).toBe(1);
    const [row] = await outboxRows();
    expect(row).toMatchObject({ state: 'abandoned', attempts: 1, last_error_class: 'unknown' });
  });

  test('backoff caps at the maximum', async () => {
    await seed(1);
    await claimDueWithOutbox(sql, {}, claimInput);
    const options = { ...publisherOptions('p'), maxAttempts: 50, maxBackoffMs: 4000 };
    const memory = createMemoryQueue(() => new QueuePublishError('http-429', true));
    const publisher = createOutboxPublisher(sql, memory.queue, options);
    let now = T1;
    let wait = 0;
    for (let i = 0; i < 6; i += 1) {
      await publisher.publishBatch({ now, limit: 1 });
      const [row] = await outboxRows();
      wait = row.next_attempt_at.getTime() - Date.parse(now);
      now = row.next_attempt_at.toISOString();
    }
    expect(wait).toBe(3000);
  });
});
