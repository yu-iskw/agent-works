import { googleFakeTransport } from '@agent-works/fakes';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createCalendarAdapter } from './calendar/adapter.js';
import { createDocsAdapter } from './docs/adapter.js';
import { createGoogleHttp } from './google-http.js';
import { workspaceHarness, docsPayload, eventPayload, draftPayload } from './test-fixtures.js';

import type { WorkspaceHarness } from './test-fixtures.js';
let h: WorkspaceHarness;
beforeEach(async () => {
  h = await workspaceHarness();
});
afterEach(async () => {
  await h.close();
});

describe('recover writes after lost responses', () => {
  it('creates exactly one document after committed timeout', async () => {
    h.lostDocs.remaining = 1;
    const call = await h.approved();
    expect(await h.broker.execute(call)).toEqual({ id: 'doc-1', kind: 'document' });
    expect(h.docs.documents()).toHaveLength(1);
    expect((await h.approvals.read(call.approvalId))?.executionsUsed).toBe(1);
  });
  it('creates exactly one event after committed timeout', async () => {
    h.lostCalendar.remaining = 1;
    const call = await h.approved({ tool: 'calendar.createEvent', payload: eventPayload });
    expect(await h.broker.execute(call)).toMatchObject({ kind: 'event' });
    expect(h.calendar.events()).toHaveLength(3);
  });
  it('creates exactly one draft after committed timeout', async () => {
    h.lostGmail.remaining = 1;
    const call = await h.approved({ tool: 'gmail.createDraft', payload: draftPayload });
    expect(await h.broker.execute(call)).toMatchObject({ kind: 'draft' });
    expect(h.gmail.drafts()).toHaveLength(1);
  });
  it('resumes an intended write after all attempts fail', async () => {
    h.docsFailures.push(503, 503, 503);
    const call = await h.approved();
    await expect(h.broker.execute(call)).rejects.toMatchObject({ code: 'UPSTREAM_UNAVAILABLE' });
    expect((await h.approvals.read(call.approvalId))?.executionsUsed).toBe(1);
    expect(await h.broker.execute(call)).toMatchObject({ kind: 'document' });
    expect(h.docs.documents()).toHaveLength(1);
    expect((await h.approvals.read(call.approvalId))?.executionsUsed).toBe(1);
  });
  it('does not resume with an edited payload after transient failure', async () => {
    h.docsFailures.push(503, 503, 503);
    const call = await h.approved();
    await expect(h.broker.execute(call)).rejects.toMatchObject({ code: 'UPSTREAM_UNAVAILABLE' });
    await expect(
      h.broker.execute({ ...call, payload: { ...docsPayload, title: 'Forged' } }),
    ).rejects.toMatchObject({ code: 'APPROVAL_REQUIRED' });
    expect(h.docs.documents()).toEqual([]);
  });
  it('handles quota without spending another approval', async () => {
    h.docsFailures.push(429, 429);
    const call = await h.approved();
    await expect(h.broker.execute(call)).resolves.toMatchObject({ kind: 'document' });
    expect(h.docs.documents()).toHaveLength(1);
  });
  it('rejects another call using the same key', async () => {
    const call = await h.approved();
    await h.broker.execute(call);
    await expect(h.broker.execute({ ...call, callId: 'forged-call' })).rejects.toMatchObject({
      code: 'DUPLICATE_CALL',
    });
    expect(h.docs.documents()).toHaveLength(1);
  });
  it.each(['docs', 'calendar'] as const)(
    'recovers %s when the transport throws after the create committed',
    async (family) => {
      const transport = googleFakeTransport(
        family === 'docs' ? h.docs.handler : h.calendar.handler,
      );
      let timedOut = false;
      const load: typeof fetch = async (input, options) => {
        const response = await transport(input, options);
        if (!timedOut) {
          timedOut = true;
          throw new DOMException('lost response', 'TimeoutError');
        }
        return response;
      };
      const http = createGoogleHttp({
        baseUrl: 'http://127.0.0.1',
        fetch: load,
        sleep: () => Promise.resolve(),
      });
      const receipt =
        family === 'docs'
          ? await createDocsAdapter(http).createDraft(h.credential, docsPayload, 'timeout-key')
          : await createCalendarAdapter(http).createEvent(
              h.credential,
              eventPayload,
              'timeout-key',
            );
      expect(receipt.id).toBeTruthy();
      expect(family === 'docs' ? h.docs.documents().length : h.calendar.events().length).toBe(
        family === 'docs' ? 1 : 3,
      );
    },
  );
});
