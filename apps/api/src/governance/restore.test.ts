import { describe, expect, it } from 'vitest';

import { createMemoryGovernancePort } from '../ports/memory/governance.js';

import { processDeletion, requestDeletion } from './deletion-requests.js';
import { changeLegalHold } from './holds.js';
import { reapplyAfterRestore } from './restore.js';
import { revokeSource } from './source-revocation.js';
import {
  CREATED,
  EXPIRED,
  governanceFixture,
  HOLD_ID,
  recordFixture,
  REQUEST_ID,
  SECRET,
} from './test-fixtures.js';

import type { GovernanceState } from '../ports/governance.js';

const at = new Date(CREATED);
const officer = 'officer';
const ownerHold = {
  commandId: HOLD_ID,
  target: { kind: 'owner' as const, id: 'alice' },
  action: 'set' as const,
  reasonRef: 'legal-case',
};
async function restored(backup: GovernanceState) {
  const port = createMemoryGovernancePort();
  await port.transact((state) => Object.assign(state, backup));
  return port;
}

describe('offline restore evidence reconciliation', () => {
  it('imports the current release stream before deleting data that was held in a backup', async () => {
    const { port, store } = await governanceFixture();
    await store.put(recordFixture(), SECRET);
    await changeLegalHold(port, ownerHold, officer, at);
    const backup = await port.snapshot();
    await changeLegalHold(
      port,
      { ...ownerHold, commandId: REQUEST_ID, action: 'release' },
      officer,
      EXPIRED,
    );
    await requestDeletion(
      port,
      { requestId: REQUEST_ID, subject: 'alice', reasonRef: 'privacy' },
      officer,
      EXPIRED,
    );
    await processDeletion(port, REQUEST_ID, officer, EXPIRED);
    const restore = await restored(backup);
    expect(
      await reapplyAfterRestore(restore, await port.snapshot(), 'held-backup', EXPIRED),
    ).toEqual({ repurged: ['artifact-1'] });
    expect((await restore.snapshot()).holds.map((row) => row.action)).toEqual(['set', 'release']);
    expect((await restore.snapshot()).artifacts).toEqual([]);
  });

  it('re-purges source revocations even when the restored artifact predates the revocation evidence', async () => {
    const { port } = await governanceFixture();
    const backup = await port.snapshot();
    // The artifact exists only in the isolated restored dataset. Source fencing
    // still applies without an original per-record tombstone in live evidence.
    const restore = await restored(backup);
    const { store: restoredStore } = await governanceFixture(restore);
    await restoredStore.put(recordFixture(), SECRET);
    await restoredStore.derive('artifact-1', 'derived-1', 'cache', SECRET);
    await revokeSource(port, 'source-1', officer, EXPIRED);
    expect(
      await reapplyAfterRestore(restore, await port.snapshot(), 'source-drill', EXPIRED),
    ).toEqual({ repurged: ['artifact-1'] });
    const state = await restore.snapshot();
    expect(state.derived).toEqual([]);
    expect(state.tombstones[0].reason).toBe('source-revocation');
    expect(state.audit.filter((row) => row.type === 'purge')).toHaveLength(1);
  });

  it('refreshes hold summaries and retains revoked source bytes while the authoritative hold is active', async () => {
    const { port, store } = await governanceFixture();
    await store.put(recordFixture(), SECRET);
    const backup = await port.snapshot();
    await changeLegalHold(port, ownerHold, officer, at);
    await revokeSource(port, 'source-1', officer, EXPIRED);
    const restore = await restored(backup);
    expect(
      await reapplyAfterRestore(restore, await port.snapshot(), 'held-source', EXPIRED),
    ).toEqual({ repurged: [] });
    const state = await restore.snapshot();
    expect(state.artifacts[0].record.legalHold).toBe(true);
    expect(state.revokedSources).toEqual(['source-1']);
  });

  it('rejects evidence with a conflicting immutable audit record and rolls back the drill', async () => {
    const { port } = await governanceFixture();
    await changeLegalHold(port, ownerHold, officer, at);
    const backup = await port.snapshot();
    const evidence = structuredClone(backup);
    evidence.audit[0].occurredAt = EXPIRED.toISOString();
    const restore = await restored(backup);
    await expect(reapplyAfterRestore(restore, evidence, 'conflict', EXPIRED)).rejects.toThrow(
      'evidence conflict',
    );
    expect(await restore.snapshot()).toEqual(backup);
  });

  it('rejects stale evidence that would remove a known legal hold', async () => {
    const { port } = await governanceFixture();
    const stale = await port.snapshot();
    await changeLegalHold(port, ownerHold, officer, at);
    const before = await port.snapshot();
    await expect(reapplyAfterRestore(port, stale, 'stale', EXPIRED)).rejects.toThrow('append-only');
    expect(await port.snapshot()).toEqual(before);
  });

  it('validates deletion evidence before touching the restored database', async () => {
    const { port } = await governanceFixture();
    await requestDeletion(
      port,
      { requestId: REQUEST_ID, subject: 'alice', reasonRef: 'privacy' },
      officer,
      at,
    );
    const evidence = await port.snapshot();
    evidence.requests[0].state = 'PURGED';
    const restore = createMemoryGovernancePort();
    const before = await restore.snapshot();
    await expect(reapplyAfterRestore(restore, evidence, 'forged', EXPIRED)).rejects.toThrow(
      'summary',
    );
    expect(await restore.snapshot()).toEqual(before);
  });
});
