import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { workspaceHarness, draftPayload } from '../test-fixtures.js';

import type { WorkspaceHarness } from '../test-fixtures.js';
let h: WorkspaceHarness;
beforeEach(async () => {
  h = await workspaceHarness();
});
afterEach(async () => {
  await h.close();
});
describe('gmail HTTP adapter contract', () => {
  it('creates a typed receipt and preserves the exact payload', async () => {
    const receipt = await h.adapters.gmail.createDraft(h.credential, draftPayload, 'contract-key');
    expect(receipt).toMatchObject({ kind: 'draft' });
    expect(receipt.id).toBeTruthy();
    expect(h.gmail.drafts().at(-1)).toMatchObject({ ...draftPayload, owner: 'alice' });
  });
  it('retries quota with the same idempotency key', async () => {
    h.gmailFailures.push(429);
    const receipt = await h.adapters.gmail.createDraft(h.credential, draftPayload, 'contract-key');
    expect(receipt.kind).toBe('draft');
    expect(h.gmail.drafts().filter((row) => row.id === receipt.id)).toHaveLength(1);
  });
  it('returns the same receipt for an identical retry', async () => {
    const first = await h.adapters.gmail.createDraft(h.credential, draftPayload, 'contract-key');
    const second = await h.adapters.gmail.createDraft(h.credential, draftPayload, 'contract-key');
    expect(second).toEqual(first);
    expect(h.gmail.drafts().filter((row) => row.id === first.id)).toHaveLength(1);
  });
  it('does not overwrite after a conflicting idempotency retry', async () => {
    const first = await h.adapters.gmail.createDraft(h.credential, draftPayload, 'contract-key');
    await expect(
      h.adapters.gmail.createDraft(
        h.credential,
        { ...draftPayload, subject: 'Changed' },
        'contract-key',
      ),
    ).rejects.toMatchObject({ code: 'INVALID_REQUEST' });
    expect(h.gmail.drafts().filter((row) => row.id === first.id)).toHaveLength(1);
  });
  it('has a bounded retry budget for quota', async () => {
    h.gmailFailures.push(429, 429, 429, 429);
    await expect(
      h.adapters.gmail.createDraft(h.credential, draftPayload, 'contract-key'),
    ).rejects.toMatchObject({ code: 'QUOTA_EXHAUSTED', status: 429 });
    expect(h.gmailFailures).toHaveLength(1);
  });
  it('has a bounded retry budget for provider failure', async () => {
    h.gmailFailures.push(503, 503, 503, 503);
    await expect(
      h.adapters.gmail.createDraft(h.credential, draftPayload, 'contract-key'),
    ).rejects.toMatchObject({ code: 'UPSTREAM_UNAVAILABLE', status: 503 });
    expect(h.gmailFailures).toHaveLength(1);
  });
  it('maps unauthorized without exposing raw upstream data', async () => {
    await expect(
      h.adapters.gmail.createDraft(
        { ...h.credential, token: 'unknown' },
        draftPayload,
        'contract-key',
      ),
    ).rejects.toMatchObject({ code: 'AUTH_REVOKED', message: 'AUTH_REVOKED' });
  });
  it('rejects unknown argument properties', async () => {
    await expect(
      h.adapters.gmail.createDraft(h.credential, { ...draftPayload, owner: 'bob' }, 'contract-key'),
    ).rejects.toThrow();
  });
  it('requires an idempotency key before a network attempt', async () => {
    await expect(
      h.adapters.gmail.createDraft(h.credential, draftPayload, ''),
    ).rejects.toMatchObject({ code: 'INVALID_REQUEST' });
  });
  it('does not dispatch when caller cancellation already happened', async () => {
    const signal = AbortSignal.abort();
    await expect(
      h.adapters.gmail.createDraft(h.credential, draftPayload, 'contract-key', signal),
    ).rejects.toThrow();
  });
});
