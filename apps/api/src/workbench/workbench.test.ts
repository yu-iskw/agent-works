import { randomUUID } from 'node:crypto';

import { safeWorkbenchUrl } from '@agent-works/domain/workbench';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { openSql, startDisposablePostgres } from '../ledger/disposable-postgres.js';

import { applyWorkbenchMigration } from './migration.js';
import { callLimit } from './runtime.js';
import { createWorkbenchService, WorkbenchConflict } from './service.js';
import { createStubModel } from './stub-model.js';
import { createWorkbenchWorker } from './worker.js';
import { createFixtureWorkspace, searchCorpus } from './workspace.js';

import type { ModelPort } from './model-port.js';
import type { Owner, WorkbenchDeps } from './service.js';
import type { DisposablePostgres } from '../ledger/disposable-postgres.js';
import type { Sql } from 'postgres';

const alice: Owner = { sub: 'alice', email: 'alice@example.test' };
const bob: Owner = { sub: 'bob', email: 'bob@example.test' };
const flagship =
  'Review the October incident reports in my authorized Google Drive, identify recurring causes with citations, and draft a summary Google Doc for my approval.';

let database: DisposablePostgres | undefined;
let sql: Sql;

beforeAll(async () => {
  database = await startDisposablePostgres();
  sql = openSql(database.url);
  await applyWorkbenchMigration(sql);
  await applyWorkbenchMigration(sql);
}, 60_000);

afterAll(async () => {
  await sql.end({ timeout: 1 });
  await database?.stop();
});

beforeEach(async () => {
  await sql`truncate wb_actions, wb_approvals, wb_artifacts, wb_evidence, wb_events, wb_model_calls, wb_fixture_docs, wb_tasks cascade`;
});

function harness(model: ModelPort = createStubModel(true), maxModelCalls = 10) {
  const deps: WorkbenchDeps = {
    sql,
    model: { kind: 'ready', model },
    workspace: createFixtureWorkspace(sql),
    faultsEnabled: true,
    maxModelCalls,
    vertex: { project: 'p', location: 'global' },
    credentialsPath: undefined,
    now: () => new Date(),
    newId: randomUUID,
  };
  const service = createWorkbenchService(deps);
  const worker = createWorkbenchWorker({ deps });
  return { service, worker };
}

async function submit(
  service: ReturnType<typeof harness>['service'],
  objective = flagship,
  owner = alice,
) {
  return (await service.create(owner, { objective, clientRequestId: randomUUID() })).task;
}

async function docs(): Promise<number> {
  const rows = await sql<{ n: number }[]>`select count(*)::int as n from wb_fixture_docs`;
  return rows.at(0)?.n ?? -1;
}

describe('workbench flagship flow', () => {
  it('runs prompt to evidence to draft to approval to exactly one write', async () => {
    const { service, worker } = harness();
    const task = await submit(service);
    await worker.tick();
    const waiting = await service.detail(alice.sub, task.id);
    expect(waiting?.task.status).toBe('waiting_approval');
    expect(waiting?.evidence.map((item) => item.sourceId)).toEqual([
      'inc-2026-10-03-checkout-tls',
      'inc-2026-10-09-orders-db-pool',
      'inc-2026-10-14-notifications-backlog',
      'inc-2026-10-21-search-cert-renewal',
      'inc-2026-10-27-billing-pool-deploy',
    ]);
    expect(waiting?.artifact?.model.mode).toBe('stub');
    expect(waiting?.approval?.state).toBe('pending');
    expect(waiting?.approval?.proposal.simulated).toBe(true);
    expect(waiting?.events.map((event) => event.type)).toEqual([
      'task.created',
      'task.started',
      'retrieval.started',
      'retrieval.completed',
      'evidence.recorded',
      'model.requested',
      'model.completed',
      'citations.validated',
      'draft.created',
      'approval.requested',
    ]);
    const digest = waiting?.approval?.payloadSha256 ?? '';
    await expect(
      service.decide(alice, task.id, {
        decision: 'approve',
        expectedPayloadSha256: 'a'.repeat(64),
      }),
    ).rejects.toThrow(new WorkbenchConflict('stale_digest'));
    expect(
      await service.decide(alice, task.id, { decision: 'approve', expectedPayloadSha256: digest }),
    ).toBe('approved');
    await expect(
      service.decide(alice, task.id, { decision: 'approve', expectedPayloadSha256: digest }),
    ).rejects.toThrow(new WorkbenchConflict('already_decided'));
    await worker.tick();
    await worker.tick();
    const done = await service.detail(alice.sub, task.id);
    expect(done?.task.status).toBe('completed');
    expect(done?.action?.status).toBe('succeeded');
    expect(done?.action?.externalUrl).toMatch(/^\/fixtures\/docs\/fxdoc-[a-f0-9]{16}$/);
    expect(await docs()).toBe(1);
  });

  it('is idempotent on duplicate submission and rejects a reused request id', async () => {
    const { service } = harness();
    const clientRequestId = randomUUID();
    const first = await service.create(alice, { objective: flagship, clientRequestId });
    const again = await service.create(alice, { objective: flagship, clientRequestId });
    expect(first.created).toBe(true);
    expect(again.created).toBe(false);
    expect(again.task.id).toBe(first.task.id);
    await expect(
      service.create(alice, { objective: 'different', clientRequestId }),
    ).rejects.toThrow(new WorkbenchConflict('client_request_reused'));
  });

  it('rejecting writes nothing and keeps the draft', async () => {
    const { service, worker } = harness();
    const task = await submit(service);
    await worker.tick();
    const digest = (await service.detail(alice.sub, task.id))?.approval?.payloadSha256 ?? '';
    await service.decide(alice, task.id, { decision: 'reject', expectedPayloadSha256: digest });
    await worker.tick();
    const detail = await service.detail(alice.sub, task.id);
    expect(detail?.task.status).toBe('declined');
    expect(detail?.artifact).not.toBeNull();
    expect(detail?.action).toBeNull();
    expect(await docs()).toBe(0);
  });
});

describe('workbench authorization', () => {
  it('hides another owner’s task from every read and command', async () => {
    const { service, worker } = harness();
    const task = await submit(service);
    await worker.tick();
    const digest = (await service.detail(alice.sub, task.id))?.approval?.payloadSha256 ?? '';
    expect(await service.detail(bob.sub, task.id)).toBeUndefined();
    expect(await service.list(bob.sub)).toEqual([]);
    expect(
      await service.decide(bob, task.id, { decision: 'approve', expectedPayloadSha256: digest }),
    ).toBeUndefined();
    expect(await service.cancel(bob.sub, task.id)).toBe(false);
    expect(await service.retry(bob.sub, task.id)).toBe(false);
    expect(await service.reconcile(bob.sub, task.id)).toBe(false);
    expect((await service.detail(alice.sub, task.id))?.task.status).toBe('waiting_approval');
  });

  it('retrieves only documents the owner can read and drops unsafe links', async () => {
    const { service, worker } = harness();
    const task = await submit(service, flagship, bob);
    await worker.tick();
    const detail = await service.detail(bob.sub, task.id);
    expect(detail?.evidence.map((item) => item.sourceId)).toEqual([
      'inc-2026-10-11-hostile-title',
      'inc-2026-10-19-bob-session-store',
    ]);
    expect(detail?.evidence[0]?.url).toBeNull();
    expect(detail?.evidence[0]?.provenance).toContain('Unsafe link removed');
  });

  it('accepts only same-origin fixture paths and https links', () => {
    expect(safeWorkbenchUrl('javascript:alert(1)')).toBeNull();
    expect(safeWorkbenchUrl('data:text/html,hi')).toBeNull();
    expect(safeWorkbenchUrl('https://user:pw@example.com/')).toBeNull();
    expect(safeWorkbenchUrl('/fixtures/drive/../admin')).toBeNull();
    expect(safeWorkbenchUrl('/fixtures/drive/inc-1')).toBe('/fixtures/drive/inc-1');
    expect(safeWorkbenchUrl('https://docs.google.com/document/d/x')).toBe(
      'https://docs.google.com/document/d/x',
    );
  });
});

describe('workbench failures and recovery', () => {
  it('marks an unconfirmed write uncertain and reconciles without duplicating', async () => {
    const { service, worker } = harness();
    const task = await submit(service, `${flagship} [fixture:docs-timeout]`);
    await worker.tick();
    const digest = (await service.detail(alice.sub, task.id))?.approval?.payloadSha256 ?? '';
    await service.decide(alice, task.id, { decision: 'approve', expectedPayloadSha256: digest });
    await worker.tick();
    expect((await service.detail(alice.sub, task.id))?.task.status).toBe('outcome_uncertain');
    expect(await docs()).toBe(1);
    await service.reconcile(alice.sub, task.id);
    const done = await service.detail(alice.sub, task.id);
    expect(done?.task.status).toBe('completed');
    expect(done?.events.at(-2)?.type).toBe('action.reconciled');
    expect(await docs()).toBe(1);
  });

  it('fails a rejected write and retries it under the same idempotency key', async () => {
    const { service, worker } = harness();
    const task = await submit(service, `${flagship} [fixture:docs-fail]`);
    await worker.tick();
    const digest = (await service.detail(alice.sub, task.id))?.approval?.payloadSha256 ?? '';
    await service.decide(alice, task.id, { decision: 'approve', expectedPayloadSha256: digest });
    await worker.tick();
    const failed = await service.detail(alice.sub, task.id);
    expect(failed?.task.status).toBe('failed');
    expect(failed?.task.errorCode).toBe('docs_failed');
    expect(await docs()).toBe(0);
    await service.retry(alice.sub, task.id);
    expect((await service.detail(alice.sub, task.id))?.task.status).toBe('executing');
  });

  it.each([
    ['[fixture:drive-denied]', 'drive_denied'],
    ['[fixture:empty]', 'no_evidence'],
    ['[stub:rate-limit]', 'rate_limited'],
    ['[stub:unavailable]', 'unavailable'],
    ['[stub:timeout]', 'timeout'],
    ['[stub:invalid]', 'invalid_output'],
  ])('fails %s with %s and a retryable state', async (marker, code) => {
    const { service, worker } = harness();
    const task = await submit(service, `${flagship} ${marker}`);
    await worker.tick();
    const detail = await service.detail(alice.sub, task.id);
    expect(detail?.task.status).toBe('failed');
    expect(detail?.task.errorCode).toBe(code);
    expect(detail?.task.errorMessage).toBeTruthy();
    expect(await service.retry(alice.sub, task.id)).toBe(true);
    expect((await service.detail(alice.sub, task.id))?.task.status).toBe('queued');
  });

  it('cancels a waiting task, voids the approval and refuses a later decision', async () => {
    const { service, worker } = harness();
    const task = await submit(service);
    await worker.tick();
    const digest = (await service.detail(alice.sub, task.id))?.approval?.payloadSha256 ?? '';
    await service.cancel(alice.sub, task.id);
    const detail = await service.detail(alice.sub, task.id);
    expect(detail?.task.status).toBe('cancelled');
    expect(detail?.approval?.state).toBe('void');
    await expect(
      service.decide(alice, task.id, { decision: 'approve', expectedPayloadSha256: digest }),
    ).rejects.toThrow(new WorkbenchConflict('already_decided'));
    expect(await docs()).toBe(0);
  });

  it('stops a running task at the next step boundary', async () => {
    const { service, worker } = harness();
    const task = await submit(service);
    await sql`update wb_tasks set status = 'running' where id = ${task.id}`;
    await service.cancel(alice.sub, task.id);
    await worker.tick();
    const detail = await service.detail(alice.sub, task.id);
    expect(detail?.task.status).toBe('cancelled');
    expect(detail?.approval).toBeNull();
  });

  it('fails closed when the real-model call budget is spent', async () => {
    const vertexLike: ModelPort = {
      ...createStubModel(false),
      mode: 'vertex',
      modelId: 'gemini-x',
    };
    const { service, worker } = harness(vertexLike, 0);
    const task = await submit(service);
    await worker.tick();
    const detail = await service.detail(alice.sub, task.id);
    expect(detail?.task.errorCode).toBe('budget_exhausted');
  });
});

describe('review regressions', () => {
  it('lets an expired approval fail the task so Retry drafts a fresh proposal', async () => {
    const { service, worker } = harness();
    const task = await submit(service);
    await worker.tick();
    await sql`update wb_approvals set expires_at = now() - interval '1 minute' where task_id = ${task.id}`;
    const digest = (await service.detail(alice.sub, task.id))?.approval?.payloadSha256 ?? '';
    expect(
      await service.decide(alice, task.id, { decision: 'approve', expectedPayloadSha256: digest }),
    ).toBe('expired');
    const expired = await service.detail(alice.sub, task.id);
    expect(expired?.task.status).toBe('failed');
    expect(expired?.task.errorCode).toBe('approval_expired');
    expect(expired?.approval?.state).toBe('void');
    await service.retry(alice.sub, task.id);
    await worker.tick();
    const fresh = await service.detail(alice.sub, task.id);
    expect(fresh?.task.status).toBe('waiting_approval');
    expect(fresh?.approval?.state).toBe('pending');
    expect(await docs()).toBe(0);
  });

  it('fails a task on an unexpected error instead of re-claiming it forever', async () => {
    let calls = 0;
    const broken: ModelPort = {
      ...createStubModel(false),
      generate: () => {
        calls += 1;
        return Promise.reject(new TypeError('not a ModelError'));
      },
    };
    const { service, worker } = harness(broken);
    const task = await submit(service);
    await worker.tick();
    await worker.tick();
    const detail = await service.detail(alice.sub, task.id);
    expect(detail?.task.status).toBe('failed');
    expect(detail?.task.errorCode).toBe('internal_error');
    expect(calls).toBe(1);
  });

  it('matches month names as whole words only', () => {
    const hits = searchCorpus(
      'alice',
      'Review the October incident reports that may share a cause',
    );
    expect(hits.map((hit) => hit.sourceId)).toContain('inc-2026-10-03-checkout-tls');
  });

  it('parses the call budget and fails closed on garbage', () => {
    expect(callLimit(undefined)).toBe(150);
    expect(callLimit(' 40 ')).toBe(40);
    expect(callLimit('abc')).toBe(0);
    expect(callLimit('')).toBe(0);
    expect(callLimit('1_000')).toBe(0);
  });
});
