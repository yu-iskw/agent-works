import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  workspaceHarness,
  workspaceCall,
  docsPayload,
  eventPayload,
  draftPayload,
} from './test-fixtures.js';

import type { WorkspaceHarness } from './test-fixtures.js';
let h: WorkspaceHarness;
beforeEach(async () => {
  h = await workspaceHarness();
});
afterEach(async () => {
  await h.close();
});

describe('workspace payload bound single use approval', () => {
  it('rejects a write without an approval before the HTTP call', async () => {
    await expect(h.broker.execute(workspaceCall())).rejects.toMatchObject({
      code: 'APPROVAL_REQUIRED',
    });
    expect(h.docs.documents()).toEqual([]);
  });
  it('rejects an edited document body', async () => {
    const call = await h.approved();
    await expect(
      h.broker.execute({ ...call, payload: { ...docsPayload, body: 'edited' } }),
    ).rejects.toMatchObject({ code: 'APPROVAL_REQUIRED' });
    expect(h.docs.documents()).toEqual([]);
  });
  it('rejects an edited destination', async () => {
    const call = await h.approved();
    await expect(
      h.broker.execute({ ...call, payload: { ...docsPayload, destinationId: 'bob-folder' } }),
    ).rejects.toMatchObject({ code: 'APPROVAL_REQUIRED' });
    expect(h.docs.documents()).toEqual([]);
  });
  it('rejects consumption by another caller', async () => {
    const call = await h.approved();
    await expect(h.broker.execute({ ...call, subject: 'bob' })).rejects.toMatchObject({
      code: 'APPROVAL_REQUIRED',
    });
    expect(h.docs.documents()).toEqual([]);
  });
  it('rejects approval reuse with another call or key', async () => {
    const call = await h.approved();
    await h.broker.execute(call);
    await expect(
      h.broker.execute({ ...call, callId: 'another', idempotencyKey: 'other' }),
    ).rejects.toMatchObject({ code: 'APPROVAL_REQUIRED' });
    expect(h.docs.documents()).toHaveLength(1);
  });
  it('rejects a completed call replay without another write', async () => {
    const call = await h.approved();
    await h.broker.execute(call);
    await expect(h.broker.execute(call)).rejects.toMatchObject({ code: 'DUPLICATE_CALL' });
    expect(h.docs.documents()).toHaveLength(1);
  });
  it('audits intent before completed receipt without body content', async () => {
    const call = await h.approved();
    await h.broker.execute(call);
    expect(h.audit.map((event) => event.type)).toEqual(['tool.intended', 'tool.completed']);
    expect(JSON.stringify(h.audit)).not.toContain(docsPayload.body);
    expect(h.audit[0].payloadSha256).toMatch(/^[a-f0-9]{64}$/);
  });
  it('rejects a changed task, step, and tool binding', async () => {
    const call = await h.approved();
    for (const patch of [
      { taskId: 'other' },
      { stepId: 'other' },
      { tool: 'calendar.createEvent' as const, payload: eventPayload },
    ]) {
      await expect(h.broker.execute({ ...call, ...patch })).rejects.toMatchObject({
        code: 'APPROVAL_REQUIRED',
      });
    }
    expect(h.docs.documents()).toEqual([]);
    expect(h.calendar.events()).toHaveLength(2);
  });
  it('fails closed if policy changes after approval', async () => {
    const call = await h.approved();
    h.deny();
    await expect(h.broker.execute(call)).rejects.toMatchObject({ code: 'POLICY_DENIED' });
    expect((await h.approvals.read(call.approvalId))?.executionsUsed).toBe(0);
  });
  it('rejects expired approvals', async () => {
    const call = await h.approved();
    const row = await h.approvals.read(call.approvalId);
    if (!row) throw new Error('missing approval');
    await h.approvals.save({ ...row, expiresAt: '2026-01-01T00:00:00Z' });
    await expect(h.broker.execute(call)).rejects.toMatchObject({ code: 'APPROVAL_EXPIRED' });
    expect(h.docs.documents()).toEqual([]);
  });
  it('requires approval for calendar create and Gmail draft', async () => {
    await expect(
      h.broker.execute(workspaceCall({ tool: 'calendar.createEvent', payload: eventPayload })),
    ).rejects.toMatchObject({ code: 'APPROVAL_REQUIRED' });
    await expect(
      h.broker.execute(workspaceCall({ tool: 'gmail.createDraft', payload: draftPayload })),
    ).rejects.toMatchObject({ code: 'APPROVAL_REQUIRED' });
    expect(h.gmail.drafts()).toEqual([]);
    expect(h.calendar.events()).toHaveLength(2);
  });
  it('rejects another caller task approval without changing its execution count', async () => {
    const call = await h.approved();
    await expect(
      h.broker.execute({ ...call, subject: 'bob', callId: 'bob-call', idempotencyKey: 'bob-key' }),
    ).rejects.toMatchObject({ code: 'APPROVAL_REQUIRED' });
    expect((await h.approvals.read(call.approvalId))?.executionsUsed).toBe(0);
    expect(h.docs.documents()).toEqual([]);
  });
  it('rejects approvals with an execution limit greater than one', async () => {
    const call = await h.approved();
    const row = await h.approvals.read(call.approvalId);
    if (!row) throw new Error('approval');
    await h.approvals.save({ ...row, maxExecutions: 2 });
    await expect(h.broker.execute(call)).rejects.toMatchObject({ code: 'APPROVAL_REQUIRED' });
    expect((await h.approvals.read(call.approvalId))?.executionsUsed).toBe(0);
    expect(h.docs.documents()).toEqual([]);
  });
  it('preserves a rejected human decision as a denial of the write', async () => {
    const call = await h.approved();
    const row = await h.approvals.read(call.approvalId);
    if (!row) throw new Error('approval');
    await h.approvals.save({ ...row, state: 'rejected' });
    await expect(h.broker.execute(call)).rejects.toMatchObject({ code: 'APPROVAL_REQUIRED' });
    expect(h.docs.documents()).toEqual([]);
  });
});
