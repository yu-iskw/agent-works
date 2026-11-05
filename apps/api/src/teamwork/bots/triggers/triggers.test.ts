import { createHmac, randomUUID } from 'node:crypto';

import postgres from 'postgres';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { startDisposablePostgres } from '../../../ledger/disposable-postgres.js';
import { signedEventBytes } from '../../../scheduling/signature.js';
import { applyWorkbenchMigration } from '../../../workbench/migration.js';
import { createStarterTeam, seedCatalog } from '../../catalog.js';
import { applyGraphMigration } from '../../graph-migration.js';
import { alice, segmentDeps } from '../../graph-test-support.js';
import { applyBotsMigration } from '../migration.js';

import { createBotTriggers } from './index.js';

import type { StartBotRun } from '../execution/start.js';
import type { BotDefinition } from '@agent-works/domain';

let db: Awaited<ReturnType<typeof startDisposablePostgres>>;
let sql: postgres.Sql;
let id: string;
let now: Date;
let defer = false;
let revisionChanged = false;
let expectedRevisions: (number | undefined)[] = [];
let throwFor: string | undefined;
const key = {
  id: 'key',
  source: 'source',
  algorithm: 'HS256' as const,
  secret: Buffer.alloc(32, 4),
  revoked: false,
};
const definition: BotDefinition = {
  apiVersion: 'agent-works.bot/v1',
  name: 'Test',
  purpose: 'Test',
  planning: { mode: 'fixed' },
  workflow: {
    steps: [
      {
        id: 'read',
        title: 'Read',
        kind: 'connector_read',
        dependsOn: [],
        capability: 'drive.read',
        query: 'Read',
      },
      { id: 'result', title: 'Result', kind: 'result', dependsOn: ['read'], from: 'read' },
    ],
  },
  triggers: [
    {
      kind: 'schedule',
      timezone: 'Asia/Tokyo',
      timing: { kind: 'cron', expression: '0 9 * * *' },
      missedRun: 'run_once',
    },
  ],
  approvals: { mode: 'per_run' },
  limits: {
    maxConcurrentRunsPerBot: 1,
    maxConcurrentRunsPerUser: 1,
    runTimeoutMinutes: 60,
    maxCostMicros: null,
  },
  result: { destination: 'inbox' },
};
const start: StartBotRun = async ({ teammateId, trigger, expectedRevision }) => {
  expectedRevisions.push(expectedRevision);
  if (teammateId === throwFor) throw new Error('start_failed');
  if (revisionChanged) return { kind: 'denied', code: 'revision_changed' };
  if (defer) return { kind: 'deferred', code: 'bot_cap' };
  if (trigger.kind === 'manual') throw new Error('unexpected manual');
  const taskId = randomUUID();
  const rows = await sql<
    { task_id: string }[]
  >`insert into trigger_test_runs values (${teammateId}, ${trigger.ref}, ${taskId}) on conflict do nothing returning task_id`;
  if (rows.length) return { kind: 'started', taskId, revision: 1, digest: 'a'.repeat(64) };
  const [existing] = await sql<
    { task_id: string }[]
  >`select task_id from trigger_test_runs where teammate_id = ${teammateId} and ref = ${trigger.ref}`;
  return { kind: 'duplicate', taskId: existing.task_id };
};
const service = () =>
  createBotTriggers({
    sql,
    now: () => now,
    startBotRun: start,
    signingKeys: (source) => (source === key.source ? key : undefined),
    log: undefined,
  });
async function publish(triggers: BotDefinition['triggers'], at: string, revision = 1) {
  if (revision > 1)
    await sql`update tw_bot_revisions set state = 'superseded' where teammate_id = ${id} and state = 'published'`;
  await sql`insert into tw_bot_revisions (teammate_id, revision, definition, digest, state, source, created_by, created_at, published_by, published_at) values (${id}, ${revision}, ${sql.json({ ...definition, triggers })}, ${'a'.repeat(64)}, 'published', 'api', ${alice.sub}, ${at}, ${alice.sub}, ${at})`;
  await sql`update tw_bots set active_revision = ${revision} where teammate_id = ${id}`;
}
beforeAll(async () => {
  db = await startDisposablePostgres();
  sql = postgres(db.url, { onnotice: () => undefined });
  await applyWorkbenchMigration(sql);
  await applyGraphMigration(sql);
  await applyBotsMigration(sql);
  await sql`create table trigger_test_runs (teammate_id uuid, ref text, task_id uuid, unique (teammate_id, ref))`;
}, 60000);
afterAll(async () => {
  await sql.end({ timeout: 1 });
  await db.stop();
});
beforeEach(async () => {
  await sql`truncate tw_teammates, tw_conversations, tw_messages, tw_audit, trigger_test_runs cascade`;
  const deps = segmentDeps(sql);
  await seedCatalog(deps);
  id = (await createStarterTeam(deps, alice))[0].id;
  await sql`insert into tw_bots (teammate_id, owner_sub, updated_at) values (${id}, ${alice.sub}, now())`;
  defer = false;
  revisionChanged = false;
  expectedRevisions = [];
  throwFor = undefined;
});
describe('bot triggers', () => {
  it('one bot failing never stops other bots on a tick or an event (CR-04)', async () => {
    const deps = segmentDeps(sql);
    const other = (await createStarterTeam(deps, alice)).at(-1)?.id;
    if (other === undefined || other === id) throw new Error('second teammate');
    const triggers = [
      ...definition.triggers,
      { kind: 'event' as const, source: key.source, eventType: 'changed' },
    ];
    await publish(triggers, '2026-01-01T00:00:00.000Z');
    await sql`insert into tw_bots (teammate_id, owner_sub, updated_at) values (${other}, ${alice.sub}, now())`;
    await sql`insert into tw_bot_revisions (teammate_id, revision, definition, digest, state, source, created_by, created_at, published_by, published_at)
      values (${other}, 1, ${sql.json({ ...definition, triggers })}, ${'a'.repeat(64)}, 'published', 'api', ${alice.sub}, '2026-01-01T00:00:00.000Z', ${alice.sub}, '2026-01-01T00:00:00.000Z')`;
    await sql`update tw_bots set active_revision = 1 where teammate_id = ${other}`;
    now = new Date('2026-01-02T00:00:00.000Z');
    for (const failing of [id, other]) {
      throwFor = failing;
      await sql`truncate trigger_test_runs`;
      await sql`delete from tw_bot_trigger_cursors`;
      const report = await service().tick();
      expect(report).toMatchObject({ started: 1, failed: 1 });
      expect(await sql`select teammate_id from trigger_test_runs`).toEqual([
        { teammate_id: failing === id ? other : id },
      ]);
    }
    expect(
      await sql`select 1 from tw_audit where action = 'bot.trigger.schedule' and outcome = 'error'`,
    ).toHaveLength(2);
    // Event: the failing bot is deferred for the sender's retry; the other bot still starts.
    throwFor = id;
    await sql`truncate trigger_test_runs`;
    const unsigned = {
      triggerId: 'changed',
      source: key.source,
      eventId: 'isolation',
      timestamp: now.toISOString(),
      keyId: key.id,
      body: Buffer.from('{"value":1}'),
    };
    const result = await service().ingest({
      ...unsigned,
      signature: createHmac('sha256', key.secret).update(signedEventBytes(unsigned)).digest('hex'),
    });
    expect(result.outcome).toBe('started');
    expect(result.runs).toEqual(
      expect.arrayContaining([
        { teammateId: id, outcome: 'deferred' },
        expect.objectContaining({ teammateId: other, outcome: 'started' }),
      ]),
    );
  });
  it('fires Tokyo slots once across concurrent ticks and does not backfill a new revision', async () => {
    await publish(definition.triggers, '2026-01-01T00:00:00.000Z');
    now = new Date('2026-01-02T00:00:00.000Z');
    await Promise.all([service().tick(), service().tick()]);
    expect(await sql`select * from trigger_test_runs`).toHaveLength(1);
    await publish(definition.triggers, now.toISOString(), 2);
    await service().tick();
    expect(await sql`select * from trigger_test_runs`).toHaveLength(1);
  });
  it('skips or fires the latest missed slot after an outage', async () => {
    const schedule = definition.triggers[0];
    if (schedule.kind !== 'schedule') throw new Error('schedule');
    await publish([{ ...schedule, missedRun: 'skip' }], '2026-01-01T00:00:00.000Z');
    now = new Date('2026-01-04T00:05:00.000Z');
    await service().tick();
    expect(await sql`select * from trigger_test_runs`).toHaveLength(0);
    await publish([{ ...schedule, missedRun: 'run_once' }], '2026-01-04T00:05:00.000Z', 2);
    now = new Date('2026-01-07T00:05:00.000Z');
    await service().tick();
    expect((await sql<{ ref: string }[]>`select ref from trigger_test_runs`)[0].ref).toContain(
      '2026-01-07T00:00:00.000Z',
    );
  });
  it('retries a deferred slot and audits capacity expiry', async () => {
    await publish(definition.triggers, '2026-01-01T00:00:00.000Z');
    now = new Date('2026-01-02T00:00:00.000Z');
    defer = true;
    await service().tick();
    defer = false;
    now = new Date('2026-01-02T00:10:00.000Z');
    await service().tick();
    expect(await sql`select * from trigger_test_runs`).toHaveLength(1);
    now = new Date('2026-01-03T00:00:00.000Z');
    defer = true;
    await service().tick();
    now = new Date('2026-01-04T00:01:00.000Z');
    await service().tick();
    expect(await sql`select * from tw_audit where outcome = 'missed_due_to_capacity'`).toHaveLength(
      1,
    );
  });
  it('follows New York spring and fall clock changes', async () => {
    const spring: BotDefinition['triggers'] = [
      {
        kind: 'schedule',
        timezone: 'America/New_York',
        timing: { kind: 'cron', expression: '30 2 * * *' },
        missedRun: 'skip',
      },
    ];
    await publish(spring, '2026-03-08T00:00:00.000Z');
    now = new Date('2026-03-08T07:30:00.000Z');
    await service().tick();
    expect(await sql`select * from trigger_test_runs`).toHaveLength(0);
    const fall: BotDefinition['triggers'] = [
      {
        kind: 'schedule',
        timezone: 'America/New_York',
        timing: { kind: 'cron', expression: '30 1 * * *' },
        missedRun: 'skip',
      },
    ];
    await publish(fall, '2026-11-01T00:00:00.000Z', 2);
    now = new Date('2026-11-01T05:30:00.000Z');
    await service().tick();
    now = new Date('2026-11-01T06:30:00.000Z');
    await service().tick();
    expect(await sql`select * from trigger_test_runs`).toHaveLength(2);
  });
  it('audits changed revisions and does not retry the matched occurrence', async () => {
    const eventTrigger: BotDefinition['triggers'][number] = {
      kind: 'event',
      source: 'source',
      eventType: 'changed',
    };
    await publish([...definition.triggers, eventTrigger], '2026-01-01T00:00:00.000Z');
    now = new Date('2026-01-02T00:00:00.000Z');
    revisionChanged = true;
    const api = service();
    expect((await api.tick()).denied).toBe(1);
    const unsigned = {
      triggerId: 'changed',
      source: 'source',
      eventId: 'event',
      timestamp: now.toISOString(),
      keyId: key.id,
      body: Buffer.from('{}'),
    };
    const event = {
      ...unsigned,
      signature: createHmac('sha256', key.secret).update(signedEventBytes(unsigned)).digest('hex'),
    };
    expect((await api.ingest(event)).outcome).toBe('ignored');
    expect(expectedRevisions).toEqual([1, 1]);
    expect(await sql`select * from tw_audit where outcome = 'revision_changed'`).toHaveLength(2);
    revisionChanged = false;
    await api.tick();
    expect(expectedRevisions).toEqual([1, 1]);
    expect(await sql`select * from trigger_test_runs`).toHaveLength(0);
  });
  it('authenticates and deduplicates signed events', async () => {
    await publish(
      [{ kind: 'event', source: 'source', eventType: 'changed' }],
      '2026-01-01T00:00:00.000Z',
    );
    now = new Date('2026-01-02T00:00:00.000Z');
    const unsigned = {
      triggerId: 'changed',
      source: 'source',
      eventId: 'event',
      timestamp: now.toISOString(),
      keyId: key.id,
      body: Buffer.from('{"value":1}'),
    };
    const event = {
      ...unsigned,
      signature: createHmac('sha256', key.secret).update(signedEventBytes(unsigned)).digest('hex'),
    };
    const api = service();
    expect((await api.ingest(event)).outcome).toBe('started');
    expect((await api.ingest(event)).outcome).toBe('duplicate');
    const request = (value: unknown) =>
      api.handleBotEventRequest({
        method: 'POST',
        path: '/v1/teamwork/bot-events',
        headers: {},
        body: Buffer.from(JSON.stringify(value)),
      });
    expect((await request({ ...event, signature: '0'.repeat(64) })).status).toBe(401);
    expect((await request({ ...event, source: 'unknown' })).status).toBe(401);
  });
});
