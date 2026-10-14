import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  workspaceHarness,
  workspaceCall,
  docsPayload,
  draftPayload,
  listPayload,
  connection,
} from './test-fixtures.js';

import type { WorkspaceHarness } from './test-fixtures.js';
let h: WorkspaceHarness;
beforeEach(async () => {
  h = await workspaceHarness();
});
afterEach(async () => {
  await h.close();
});

describe('caller isolation through every read tool', () => {
  it('returns only caller events from primary calendar', async () => {
    const rows = await h.broker.execute(
      workspaceCall({ tool: 'calendar.listEvents', payload: listPayload }),
    );
    expect(rows).toHaveLength(1);
    expect(JSON.stringify(rows)).toContain('alice-event');
    expect(JSON.stringify(rows)).not.toContain('Bob salary');
  });
  it('cannot select Bob calendar', async () => {
    await expect(
      h.broker.execute(
        workspaceCall({
          tool: 'calendar.listEvents',
          payload: { ...listPayload, calendarId: 'bob' },
        }),
      ),
    ).rejects.toMatchObject({ code: 'RESOURCE_DENIED' });
  });
  it('rejects a forged subject in calendar args', async () => {
    await expect(
      h.broker.execute(
        workspaceCall({ tool: 'calendar.listEvents', payload: { ...listPayload, subject: 'bob' } }),
      ),
    ).rejects.toMatchObject({ code: 'INVALID_REQUEST' });
  });
  it('returns only caller mail even for matching query', async () => {
    const rows = await h.broker.execute(
      workspaceCall({ tool: 'gmail.searchThreads', payload: { query: 'Meeting' } }),
    );
    expect(rows).toHaveLength(1);
    expect(JSON.stringify(rows)).toContain('alice-thread');
    expect(JSON.stringify(rows)).not.toContain('Bob salary');
  });
  it('rejects a forged Gmail subject and userId', async () => {
    for (const field of ['subject', 'userId', 'owner']) {
      await expect(
        h.broker.execute(
          workspaceCall({
            tool: 'gmail.searchThreads',
            payload: { query: 'Meeting', [field]: 'bob' },
          }),
        ),
      ).rejects.toMatchObject({ code: 'INVALID_REQUEST' });
    }
  });
  it('does not fall back when caller has no connection', async () => {
    h.stored.delete('alice');
    await expect(
      h.broker.execute(workspaceCall({ tool: 'calendar.listEvents', payload: listPayload })),
    ).rejects.toMatchObject({ code: 'AUTH_REQUIRED' });
    expect(h.docs.documents()).toEqual([]);
  });
  it('rejects a substituted connection from another subject', async () => {
    h.stored.set('alice', connection('bob'));
    await expect(
      h.broker.execute(
        workspaceCall({ tool: 'gmail.searchThreads', payload: { query: 'Meeting' } }),
      ),
    ).rejects.toMatchObject({ code: 'AUTH_REQUIRED' });
  });
  it('checks fake ACL even when an adapter is called directly', async () => {
    await expect(
      h.adapters.calendar.listEvents(h.credential, { ...listPayload, calendarId: 'bob' }),
    ).rejects.toMatchObject({ code: 'RESOURCE_DENIED' });
    await expect(
      h.adapters.gmail.createDraft(
        h.credential,
        { ...draftPayload, threadId: 'bob-thread' },
        'key',
      ),
    ).rejects.toMatchObject({ code: 'RESOURCE_DENIED' });
    await expect(
      h.adapters.docs.createDraft(
        h.credential,
        { ...docsPayload, destinationId: 'bob-folder' },
        'key',
      ),
    ).rejects.toMatchObject({ code: 'RESOURCE_DENIED' });
  });
});
