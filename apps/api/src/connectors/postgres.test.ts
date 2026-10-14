/* eslint-disable vitest/no-disabled-tests -- issue 146 explicitly requires skipping unavailable disposable Postgres */
import { canonicalPayloadSha256 } from '@agent-works/domain';
import { workspaceToolRef } from '@agent-works/domain/workspace-tools';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { applyApprovalsMigration, createPostgresApprovalStore } from '../broker/approvals.js';
import { openSql, startDisposablePostgres } from '../ledger/disposable-postgres.js';

import { docsPayload, workspaceHarness } from './test-fixtures.js';

import type { DisposablePostgres } from '../ledger/disposable-postgres.js';
import type { Sql } from 'postgres';
let database: DisposablePostgres | undefined;
let sql: Sql | undefined;
beforeAll(async () => {
  try {
    database = await startDisposablePostgres();
    sql = openSql(database.url);
    await applyApprovalsMigration(sql);
  } catch {
    await sql?.end({ timeout: 1 });
    sql = undefined;
    console.warn(
      'Workspace Postgres contracts skipped: disposable Postgres unavailable in this sandbox.',
    );
  }
}, 60_000);
beforeEach(async () => {
  if (sql) await sql`truncate table tool_calls, approvals`;
});
afterAll(async () => {
  await sql?.end({ timeout: 1 });
  await database?.stop();
});
describe('workspace writes using existing durable approval storage', () => {
  it('persists bound payload across store instances and rejects replay', async (context) => {
    if (!sql) {
      context.skip();
      return;
    }
    const h = await workspaceHarness(createPostgresApprovalStore(sql));
    try {
      const call = await h.approved();
      const reopened = createPostgresApprovalStore(sql);
      expect(await reopened.readPayload(call.approvalId)).toEqual(docsPayload);
      const result = await h.broker.execute(call);
      expect(
        await reopened.readCompleted({
          callId: call.callId,
          idempotencyKey: call.idempotencyKey,
          taskId: call.taskId,
          stepId: call.stepId,
          approvalId: call.approvalId,
          actorSub: call.subject,
          toolRef: workspaceToolRef(call.tool),
          payloadSha256: canonicalPayloadSha256(call.payload),
        }),
      ).toBe('id' in result ? result.id : undefined);
      expect((await reopened.read(call.approvalId))?.executionsUsed).toBe(1);
      await expect(h.broker.execute(call)).rejects.toMatchObject({ code: 'DUPLICATE_CALL' });
      expect(h.docs.documents()).toHaveLength(1);
    } finally {
      await h.close();
    }
  });
  it('resumes durable intent after retry exhaustion without consuming approval twice', async (context) => {
    if (!sql) {
      context.skip();
      return;
    }
    const h = await workspaceHarness(createPostgresApprovalStore(sql));
    try {
      const call = await h.approved();
      h.docsFailures.push(503, 503, 503);
      await expect(h.broker.execute(call)).rejects.toMatchObject({ code: 'UPSTREAM_UNAVAILABLE' });
      expect((await h.approvals.read(call.approvalId))?.executionsUsed).toBe(1);
      expect(await h.broker.execute(call)).toMatchObject({ kind: 'document' });
      expect((await h.approvals.read(call.approvalId))?.executionsUsed).toBe(1);
      expect(h.docs.documents()).toHaveLength(1);
    } finally {
      await h.close();
    }
  });
  it('rejects a changed payload after durable claim', async (context) => {
    if (!sql) {
      context.skip();
      return;
    }
    const h = await workspaceHarness(createPostgresApprovalStore(sql));
    try {
      const call = await h.approved();
      h.docsFailures.push(503, 503, 503);
      await expect(h.broker.execute(call)).rejects.toThrow();
      await expect(
        h.broker.execute({ ...call, payload: { ...docsPayload, body: 'edited' } }),
      ).rejects.toMatchObject({ code: 'APPROVAL_REQUIRED' });
      expect(h.docs.documents()).toEqual([]);
    } finally {
      await h.close();
    }
  });
});
