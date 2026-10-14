import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { workspaceHarness, eventPayload } from '../test-fixtures.js';

import type { WorkspaceHarness } from '../test-fixtures.js';
let h: WorkspaceHarness;
beforeEach(async () => {
  h = await workspaceHarness();
});
afterEach(async () => {
  await h.close();
});
describe('calendar HTTP adapter contract', () => {
  it('creates a typed receipt and preserves the exact payload', async () => {
    const receipt = await h.adapters.calendar.createEvent(
      h.credential,
      eventPayload,
      'contract-key',
    );
    expect(receipt).toMatchObject({ kind: 'event' });
    expect(receipt.id).toBeTruthy();
    expect(h.calendar.events().at(-1)).toMatchObject({ ...eventPayload, owner: 'alice' });
  });
  it('retries quota with the same idempotency key', async () => {
    h.calendarFailures.push(429);
    const receipt = await h.adapters.calendar.createEvent(
      h.credential,
      eventPayload,
      'contract-key',
    );
    expect(receipt.kind).toBe('event');
    expect(h.calendar.events().filter((row) => row.id === receipt.id)).toHaveLength(1);
  });
  it('returns the same receipt for an identical retry', async () => {
    const first = await h.adapters.calendar.createEvent(h.credential, eventPayload, 'contract-key');
    const second = await h.adapters.calendar.createEvent(
      h.credential,
      eventPayload,
      'contract-key',
    );
    expect(second).toEqual(first);
    expect(h.calendar.events().filter((row) => row.id === first.id)).toHaveLength(1);
  });
  it('does not overwrite after a conflicting idempotency retry', async () => {
    const first = await h.adapters.calendar.createEvent(h.credential, eventPayload, 'contract-key');
    await expect(
      h.adapters.calendar.createEvent(
        h.credential,
        { ...eventPayload, summary: 'Changed' },
        'contract-key',
      ),
    ).rejects.toMatchObject({ code: 'INVALID_REQUEST' });
    expect(h.calendar.events().filter((row) => row.id === first.id)).toHaveLength(1);
  });
  it('has a bounded retry budget for quota', async () => {
    h.calendarFailures.push(429, 429, 429, 429);
    await expect(
      h.adapters.calendar.createEvent(h.credential, eventPayload, 'contract-key'),
    ).rejects.toMatchObject({ code: 'QUOTA_EXHAUSTED', status: 429 });
    expect(h.calendarFailures).toHaveLength(1);
  });
  it('has a bounded retry budget for provider failure', async () => {
    h.calendarFailures.push(503, 503, 503, 503);
    await expect(
      h.adapters.calendar.createEvent(h.credential, eventPayload, 'contract-key'),
    ).rejects.toMatchObject({ code: 'UPSTREAM_UNAVAILABLE', status: 503 });
    expect(h.calendarFailures).toHaveLength(1);
  });
  it('maps unauthorized without exposing raw upstream data', async () => {
    await expect(
      h.adapters.calendar.createEvent(
        { ...h.credential, token: 'unknown' },
        eventPayload,
        'contract-key',
      ),
    ).rejects.toMatchObject({ code: 'AUTH_REVOKED', message: 'AUTH_REVOKED' });
  });
  it('rejects unknown argument properties', async () => {
    await expect(
      h.adapters.calendar.createEvent(
        h.credential,
        { ...eventPayload, subject: 'bob' },
        'contract-key',
      ),
    ).rejects.toThrow();
  });
  it('requires an idempotency key before a network attempt', async () => {
    await expect(
      h.adapters.calendar.createEvent(h.credential, eventPayload, ''),
    ).rejects.toMatchObject({ code: 'INVALID_REQUEST' });
  });
  it('does not dispatch when caller cancellation already happened', async () => {
    const signal = AbortSignal.abort();
    await expect(
      h.adapters.calendar.createEvent(h.credential, eventPayload, 'contract-key', signal),
    ).rejects.toThrow();
  });
});
