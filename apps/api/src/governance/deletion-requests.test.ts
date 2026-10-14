import { describe, expect, it } from 'vitest';

import {
  deletionPlan,
  processDeletion,
  rejectDeletion,
  requestDeletion,
} from './deletion-requests.js';
import { changeLegalHold } from './holds.js';
import {
  CREATED,
  EXPIRED,
  governanceFixture,
  HOLD_ID,
  recordFixture,
  REQUEST_ID,
  SECRET,
} from './test-fixtures.js';

const command = { requestId: REQUEST_ID, subject: 'alice', reasonRef: 'privacy-case' };
describe('deletion request lifecycle and fan-out', () => {
  it('produces a reviewable plan across payload, derived, audit and backup stores', async () => {
    const { port, store } = await governanceFixture();
    await store.put(recordFixture(), SECRET);
    await store.derive('artifact-1', 'index-1', 'index', SECRET);
    const request = await requestDeletion(port, command, 'officer', new Date(CREATED));
    const plan = deletionPlan(await port.snapshot(), request);
    expect(plan.artifactIds).toEqual(['artifact-1']);
    expect(plan.derivedIds).toEqual(['index-1']);
    expect(plan.heldIds).toEqual([]);
    expect(plan.actions.map((action) => action.table)).toEqual([
      'governance_artifacts',
      'governance_derived',
      'governance_tombstones',
      'governance_audit',
      'offline-backups',
    ]);
    expect(plan.managedServices).toBe('operator evidence pending');
  });
  it('replays the exact command but rejects actor, subject and reason changes', async () => {
    const { port } = await governanceFixture();
    const first = await requestDeletion(port, command, 'officer', new Date(CREATED));
    expect(await requestDeletion(port, command, 'officer', EXPIRED)).toEqual(first);
    for (const changed of [
      { ...command, subject: 'bob' },
      { ...command, reasonRef: 'different' },
    ])
      await expect(requestDeletion(port, changed, 'officer', EXPIRED)).rejects.toThrow('reused');
    await expect(requestDeletion(port, command, 'other-actor', EXPIRED)).rejects.toThrow('reused');
    expect((await port.snapshot()).requests).toHaveLength(1);
  });
  it('records REQUESTED, SCHEDULED and PURGED without erasing audit history', async () => {
    const { port } = await governanceFixture();
    await requestDeletion(port, command, 'officer', new Date(CREATED));
    const processed = await processDeletion(port, REQUEST_ID, 'officer', EXPIRED);
    expect(processed.state).toBe('PURGED');
    expect(processed.revision).toBe(3);
    expect((await port.snapshot()).audit.map((event) => event.state)).toEqual([
      'REQUESTED',
      'SCHEDULED',
      'PURGED',
    ]);
  });
  it('rejects missing requests and terminal rejection reversals', async () => {
    const { port } = await governanceFixture();
    await expect(processDeletion(port, REQUEST_ID, 'officer', EXPIRED)).rejects.toThrow('missing');
    await requestDeletion(port, command, 'officer', new Date(CREATED));
    await processDeletion(port, REQUEST_ID, 'officer', EXPIRED);
    await expect(
      rejectDeletion(port, REQUEST_ID, 'denial-case', 'officer', EXPIRED),
    ).rejects.toThrow('transition');
  });
  it('a rejected request leaves payloads intact and permits later intake', async () => {
    const { port, store } = await governanceFixture();
    await store.put(recordFixture(), SECRET);
    await requestDeletion(port, command, 'officer', new Date(CREATED));
    expect(
      (await rejectDeletion(port, REQUEST_ID, 'rejection-evidence', 'officer', EXPIRED)).state,
    ).toBe('REJECTED');
    expect((await processDeletion(port, REQUEST_ID, 'officer', EXPIRED)).state).toBe('REJECTED');
    expect((await port.snapshot()).artifacts).toHaveLength(1);
    await expect(store.put(recordFixture('artifact-2'), SECRET)).resolves.toBeDefined();
    expect((await port.snapshot()).artifacts).toHaveLength(2);
  });
  it('requires and preserves rejection evidence', async () => {
    const { port } = await governanceFixture();
    await requestDeletion(port, command, 'officer', new Date(CREATED));
    await expect(rejectDeletion(port, REQUEST_ID, '', 'officer', EXPIRED)).rejects.toThrow(
      'evidence required',
    );
    const rejected = await rejectDeletion(port, REQUEST_ID, 'denial-case', 'officer', EXPIRED);
    expect(await rejectDeletion(port, REQUEST_ID, 'denial-case', 'officer', EXPIRED)).toEqual(
      rejected,
    );
    await expect(rejectDeletion(port, REQUEST_ID, 'changed', 'officer', EXPIRED)).rejects.toThrow(
      'evidence changed',
    );
  });
  it('a repeated held processing pass appends no duplicate state event', async () => {
    const { port, store } = await governanceFixture();
    await store.put(recordFixture(), SECRET);
    await changeLegalHold(
      port,
      {
        commandId: HOLD_ID,
        target: { kind: 'owner', id: 'alice' },
        action: 'set',
        reasonRef: 'hold-case',
      },
      'officer',
      new Date(CREATED),
    );
    await requestDeletion(port, command, 'officer', new Date(CREATED));
    const first = await processDeletion(port, REQUEST_ID, 'officer', EXPIRED);
    const before = await port.snapshot();
    expect(await processDeletion(port, REQUEST_ID, 'officer', EXPIRED)).toEqual(first);
    expect((await port.snapshot()).audit).toEqual(before.audit);
  });
});
