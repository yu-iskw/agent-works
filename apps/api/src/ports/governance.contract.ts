import { describe, expect, it } from 'vitest';

import { processDeletion, requestDeletion } from '../governance/deletion-requests.js';
import { changeLegalHold } from '../governance/holds.js';
import { reapplyAfterRestore } from '../governance/restore.js';
import { sweepRetention } from '../governance/retention-sweeper.js';
import { revokeSource } from '../governance/source-revocation.js';
import {
  CREATED,
  EXPIRED,
  governanceFixture,
  HOLD_ID,
  POLICY,
  readContext,
  recordFixture,
  REQUEST_ID,
  SECRET,
} from '../governance/test-fixtures.js';

import { governanceIntegrityContract } from './governance-integrity.contract.js';

import type { GovernancePort } from './governance.js';

const officer = 'officer';
const artifactId = 'artifact-1';

/** Identical behavior assertions for memory and real Postgres; no memory fallback. */
export function governanceContract(fresh: () => GovernancePort): void {
  describe('governance port contract', () => {
    it('stores only encrypted artifact and derived payloads', async () => {
      const { port, store } = await governanceFixture(fresh());
      await store.put(recordFixture(), SECRET);
      await store.derive(artifactId, 'derived-1', 'index', SECRET);
      const state = await port.snapshot();
      expect(JSON.stringify(state)).not.toContain(SECRET);
      expect(state.artifacts[0].envelope.algorithm).toBe('AES-256-GCM');
      expect(await store.read(artifactId, readContext())).toBe(SECRET);
    });
    it('rolls back a failed transaction without poisoning later operations', async () => {
      const port = fresh();
      await expect(
        port.transact((state) => {
          state.policies.push(POLICY);
          throw new Error('abort');
        }),
      ).rejects.toThrow('abort');
      expect((await port.snapshot()).policies).toEqual([]);
      await port.transact((state) => {
        state.policies.push(POLICY);
      });
      expect((await port.snapshot()).policies).toEqual([POLICY]);
    });
    it('isolates returned state aliases and transaction results', async () => {
      const { port } = await governanceFixture(fresh());
      const snapshot = await port.snapshot();
      snapshot.policies.length = 0;
      expect((await port.snapshot()).policies).toEqual([POLICY]);
      const result = await port.transact((state) => state.policies);
      result.length = 0;
      expect((await port.snapshot()).policies).toEqual([POLICY]);
    });
    it('purges expired data once and writes exactly one purge audit event', async () => {
      const { port, store } = await governanceFixture(fresh());
      await store.put(recordFixture(), SECRET);
      await store.derive(artifactId, 'derived-1', 'cache', SECRET);
      expect(await sweepRetention(port, EXPIRED)).toEqual({ purged: [artifactId], held: [] });
      expect(await sweepRetention(port, EXPIRED)).toEqual({ purged: [], held: [] });
      const state = await port.snapshot();
      expect(state.artifacts).toEqual([]);
      expect(state.derived).toEqual([]);
      expect(state.tombstones).toHaveLength(1);
      expect(state.audit.filter((event) => event.type === 'purge')).toHaveLength(1);
    });
    it('skips legal holds and purges after a release on the next sweep', async () => {
      const { port, store } = await governanceFixture(fresh());
      await store.put(recordFixture(), SECRET);
      const command = {
        commandId: HOLD_ID,
        target: { kind: 'record' as const, id: artifactId },
        action: 'set' as const,
        reasonRef: 'case-1',
      };
      await changeLegalHold(port, command, officer, new Date(CREATED));
      expect(await sweepRetention(port, EXPIRED)).toEqual({ purged: [], held: [artifactId] });
      expect((await port.snapshot()).artifacts[0].record.legalHold).toBe(true);
      await changeLegalHold(
        port,
        { ...command, commandId: REQUEST_ID, action: 'release' },
        officer,
        EXPIRED,
      );
      expect((await port.snapshot()).artifacts[0].record.legalHold).toBe(false);
      expect((await sweepRetention(port, EXPIRED)).purged).toEqual([artifactId]);
    });
    it('treats a hold retry as immutable evidence and rejects changed command identity', async () => {
      const port = fresh();
      const command = {
        commandId: HOLD_ID,
        target: { kind: 'owner' as const, id: 'alice' },
        action: 'set' as const,
        reasonRef: 'case-1',
      };
      const hold = await changeLegalHold(port, command, officer, new Date(CREATED));
      expect(await changeLegalHold(port, command, officer, EXPIRED)).toEqual(hold);
      await expect(
        changeLegalHold(port, { ...command, reasonRef: 'different' }, officer, EXPIRED),
      ).rejects.toThrow('reused');
      expect((await port.snapshot()).holds).toHaveLength(1);
      expect((await port.snapshot()).audit).toHaveLength(1);
    });
    it('holds apply to new artifacts and independent overlapping targets', async () => {
      const { port, store } = await governanceFixture(fresh());
      await changeLegalHold(
        port,
        {
          commandId: HOLD_ID,
          target: { kind: 'owner', id: 'alice' },
          action: 'set',
          reasonRef: 'owner-case',
        },
        officer,
        new Date(CREATED),
      );
      await store.put(recordFixture(), SECRET);
      await changeLegalHold(
        port,
        {
          commandId: REQUEST_ID,
          target: { kind: 'source', id: 'source-1' },
          action: 'set',
          reasonRef: 'source-case',
        },
        officer,
        new Date(CREATED),
      );
      await changeLegalHold(
        port,
        {
          commandId: '00000000-0000-4000-8000-000000000141',
          target: { kind: 'owner', id: 'alice' },
          action: 'release',
          reasonRef: 'owner-case',
        },
        officer,
        EXPIRED,
      );
      expect((await sweepRetention(port, EXPIRED)).held).toEqual([artifactId]);
    });
    deletionContract(fresh);
    governanceIntegrityContract(fresh);
  });
}

function deletionContract(fresh: () => GovernancePort): void {
  it('deletes only the requested owner and retains a tombstone audit marker', async () => {
    const { port, store } = await governanceFixture(fresh());
    await store.put(recordFixture(), SECRET);
    await store.put(recordFixture('bob-artifact', 'bob'), SECRET);
    for (const kind of ['index', 'cache', 'task-event', 'task-output'] as const)
      await store.derive(artifactId, kind, kind, SECRET);
    await requestDeletion(
      port,
      { requestId: REQUEST_ID, subject: 'alice', reasonRef: 'privacy-1' },
      officer,
      new Date(CREATED),
    );
    expect((await processDeletion(port, REQUEST_ID, officer, EXPIRED)).state).toBe('PURGED');
    const state = await port.snapshot();
    expect(state.artifacts.map((row) => row.record.id)).toEqual(['bob-artifact']);
    expect(state.derived).toEqual([]);
    expect(state.tombstones).toHaveLength(1);
    expect(state.audit.filter((event) => event.type === 'purge')[0].redactionMarker).toBe(
      'governance-tombstone-v1',
    );
    expect(JSON.stringify(state.audit)).not.toContain(SECRET);
    expect(JSON.stringify(state.tombstones)).not.toContain('alice');
    expect((await processDeletion(port, REQUEST_ID, officer, EXPIRED)).state).toBe('PURGED');
    expect((await port.snapshot()).audit).toEqual(state.audit);
  });
  it('fences owner intake from REQUESTED through terminal PURGED', async () => {
    const { port, store } = await governanceFixture(fresh());
    await requestDeletion(
      port,
      { requestId: REQUEST_ID, subject: 'alice', reasonRef: 'privacy-1' },
      officer,
      new Date(CREATED),
    );
    await expect(store.put(recordFixture(), SECRET)).rejects.toThrow('fence');
    await processDeletion(port, REQUEST_ID, officer, EXPIRED);
    await expect(store.put(recordFixture('new-artifact'), SECRET)).rejects.toThrow('fence');
  });
  it('a held deletion preserves all owner rows until every hold is released', async () => {
    const { port, store } = await governanceFixture(fresh());
    await store.put(recordFixture(), SECRET);
    await store.put(recordFixture('artifact-2'), SECRET);
    await changeLegalHold(
      port,
      {
        commandId: HOLD_ID,
        target: { kind: 'record', id: artifactId },
        action: 'set',
        reasonRef: 'case',
      },
      officer,
      new Date(CREATED),
    );
    await requestDeletion(
      port,
      { requestId: REQUEST_ID, subject: 'alice', reasonRef: 'privacy-1' },
      officer,
      new Date(CREATED),
    );
    expect((await processDeletion(port, REQUEST_ID, officer, EXPIRED)).state).toBe('HELD');
    expect((await port.snapshot()).artifacts).toHaveLength(2);
    await changeLegalHold(
      port,
      {
        commandId: '00000000-0000-4000-8000-000000000141',
        target: { kind: 'record', id: artifactId },
        action: 'release',
        reasonRef: 'case',
      },
      officer,
      EXPIRED,
    );
    expect((await processDeletion(port, REQUEST_ID, officer, EXPIRED)).state).toBe('PURGED');
    expect((await port.snapshot()).artifacts).toEqual([]);
  });
  it('re-applies deletions after a backup restore without duplicating purge evidence', async () => {
    const { port, store } = await governanceFixture(fresh());
    await store.put(recordFixture(), SECRET);
    await store.derive(artifactId, 'derived-1', 'index', SECRET);
    const backup = await port.snapshot();
    await requestDeletion(
      port,
      { requestId: REQUEST_ID, subject: 'alice', reasonRef: 'privacy-1' },
      officer,
      new Date(CREATED),
    );
    await processDeletion(port, REQUEST_ID, officer, EXPIRED);
    const evidence = await port.snapshot();
    // Simulate a restored database with its old ciphertext but current evidence missing.
    const restored = fresh();
    await restored.transact((state) => {
      Object.assign(state, backup);
    });
    expect(await reapplyAfterRestore(restored, evidence, 'drill-1', EXPIRED)).toEqual({
      repurged: [artifactId],
    });
    expect(await reapplyAfterRestore(restored, evidence, 'drill-1', EXPIRED)).toEqual({
      repurged: [],
    });
    const final = await restored.snapshot();
    expect(final.artifacts).toEqual([]);
    expect(final.derived).toEqual([]);
    expect(final.tombstones).toHaveLength(1);
    expect(final.audit.filter((event) => event.type === 'purge')).toHaveLength(1);
    expect(final.audit.filter((event) => event.type === 'restore-repurge')).toHaveLength(1);
  });
  it('source revocation fences intake and purges derived payloads', async () => {
    const { port, store } = await governanceFixture(fresh());
    await store.put(recordFixture(), SECRET);
    await store.derive(artifactId, 'derived-1', 'task-output', SECRET);
    expect(await revokeSource(port, 'source-1', officer, EXPIRED)).toEqual({
      purged: 1,
      held: 0,
    });
    expect(await revokeSource(port, 'source-1', officer, EXPIRED)).toEqual({
      purged: 0,
      held: 0,
    });
    await expect(store.put(recordFixture('new-artifact'), SECRET)).rejects.toThrow('revoked');
    expect((await port.snapshot()).derived).toEqual([]);
  });
  it('fails closed with an unavailable key and never returns ciphertext as plaintext', async () => {
    const { store, keys } = await governanceFixture(fresh());
    await store.put(recordFixture(), SECRET);
    keys.revoke('local-key-1');
    await expect(store.read(artifactId, readContext())).rejects.toThrow('key unavailable');
  });
  it('preserves append-only evidence even through the low-level port', async () => {
    const port = fresh();
    await requestDeletion(
      port,
      { requestId: REQUEST_ID, subject: 'alice', reasonRef: 'privacy-1' },
      officer,
      new Date(CREATED),
    );
    await expect(
      port.transact((state) => {
        state.audit = [];
      }),
    ).rejects.toThrow('append-only');
    expect((await port.snapshot()).audit).toHaveLength(1);
  });
}
