import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { workspaceHarness, workspaceCall, listPayload, connection } from './test-fixtures.js';

import type { WorkspaceHarness } from './test-fixtures.js';
let h: WorkspaceHarness;
beforeEach(async () => {
  h = await workspaceHarness();
});
afterEach(async () => {
  await h.close();
});

describe('incremental credentials and revocation', () => {
  it('turns missing scopes into step-up without provider error leakage', async () => {
    h.stored.set('alice', { ...connection(), scope: 'openid' });
    await expect(
      h.broker.execute(workspaceCall({ tool: 'calendar.listEvents', payload: listPayload })),
    ).rejects.toMatchObject({ code: 'STEP_UP_REQUIRED', status: 409, message: 'STEP_UP_REQUIRED' });
    expect(h.authEvents).toEqual([]);
  });
  it('fails closed for locally revoked connections with audit', async () => {
    h.stored.set('alice', { ...connection(), status: 'revoked' });
    await expect(
      h.broker.execute(workspaceCall({ tool: 'calendar.listEvents', payload: listPayload })),
    ).rejects.toMatchObject({ code: 'AUTH_REVOKED' });
    expect(h.authEvents).toEqual([
      expect.objectContaining({ subject: 'alice', type: 'oauth.blocked', code: 'AUTH_REVOKED' }),
    ]);
  });
  it('fails closed for remote revocation before consuming approval', async () => {
    const call = await h.approved();
    h.setRemote({ ...connection(), status: 'revoked' });
    await expect(h.broker.execute(call)).rejects.toMatchObject({ code: 'AUTH_REVOKED' });
    expect((await h.approvals.read(call.approvalId))?.executionsUsed).toBe(0);
    expect(h.docs.documents()).toEqual([]);
  });
  it('fails closed for a provider subject substitution', async () => {
    h.setRemote(connection('bob'));
    await expect(
      h.broker.execute(
        workspaceCall({ tool: 'gmail.searchThreads', payload: { query: 'Meeting' } }),
      ),
    ).rejects.toMatchObject({ code: 'AUTH_REVOKED' });
    expect(h.authEvents).toHaveLength(1);
  });
  it('fails closed for expiry at the boundary instant', async () => {
    h.stored.set('alice', { ...connection(), expiresAt: '2026-10-14T10:00:00Z' });
    await expect(
      h.broker.execute(workspaceCall({ tool: 'calendar.listEvents', payload: listPayload })),
    ).rejects.toMatchObject({ code: 'AUTH_REVOKED' });
    expect(h.authEvents).toHaveLength(1);
  });
  it('requires both local and remote grants to cover the tool', async () => {
    h.setRemote({ ...connection(), scope: 'openid' });
    await expect(
      h.broker.execute(
        workspaceCall({ tool: 'gmail.searchThreads', payload: { query: 'Meeting' } }),
      ),
    ).rejects.toMatchObject({ code: 'STEP_UP_REQUIRED' });
  });
  it('accepts a Calendar write scope for reads without requesting a broader scope', async () => {
    const grant = { ...connection(), scope: 'https://www.googleapis.com/auth/calendar.events' };
    h.stored.set('alice', grant);
    h.setRemote(grant);
    const rows = await h.broker.execute(
      workspaceCall({ tool: 'calendar.listEvents', payload: listPayload }),
    );
    expect(rows).toHaveLength(1);
    expect(h.authEvents).toEqual([]);
  });
  it('does not treat Gmail compose authority as Gmail read authority', async () => {
    const grant = { ...connection(), scope: 'https://www.googleapis.com/auth/gmail.compose' };
    h.stored.set('alice', grant);
    h.setRemote(grant);
    await expect(
      h.broker.execute(
        workspaceCall({ tool: 'gmail.searchThreads', payload: { query: 'Meeting' } }),
      ),
    ).rejects.toMatchObject({ code: 'STEP_UP_REQUIRED' });
    expect(h.authEvents).toEqual([]);
  });
  it('checks remote revocation again on the next read rather than caching a usable credential', async () => {
    const call = workspaceCall({ tool: 'calendar.listEvents', payload: listPayload });
    await expect(h.broker.execute(call)).resolves.toHaveLength(1);
    h.setRemote({ ...connection(), status: 'revoked' });
    await expect(h.broker.execute(call)).rejects.toMatchObject({ code: 'AUTH_REVOKED' });
    expect(h.authEvents).toHaveLength(1);
  });
  it('rejects a substituted remote token reference even when subject and scope match', async () => {
    h.setRemote({ ...connection(), tokenRef: 'ref-another-grant' });
    await expect(
      h.broker.execute(workspaceCall({ tool: 'calendar.listEvents', payload: listPayload })),
    ).rejects.toMatchObject({ code: 'AUTH_REVOKED' });
    expect(h.authEvents).toEqual([
      expect.objectContaining({ type: 'oauth.blocked', subject: 'alice' }),
    ]);
  });
  it('rejects remote expiry before spending a write approval', async () => {
    const call = await h.approved();
    h.setRemote({ ...connection(), expiresAt: '2026-10-14T10:00:00Z' });
    await expect(h.broker.execute(call)).rejects.toMatchObject({ code: 'AUTH_REVOKED' });
    expect(h.docs.documents()).toEqual([]);
    expect((await h.approvals.read(call.approvalId))?.executionsUsed).toBe(0);
  });
  it('cannot recover an intended write after its credentials are revoked', async () => {
    h.docsFailures.push(503, 503, 503);
    const call = await h.approved();
    await expect(h.broker.execute(call)).rejects.toMatchObject({ code: 'UPSTREAM_UNAVAILABLE' });
    h.setRemote({ ...connection(), status: 'revoked' });
    await expect(h.broker.execute(call)).rejects.toMatchObject({ code: 'AUTH_REVOKED' });
    expect(h.docs.documents()).toEqual([]);
    expect((await h.approvals.read(call.approvalId))?.executionsUsed).toBe(1);
  });
});
