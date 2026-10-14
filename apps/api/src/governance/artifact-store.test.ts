import {
  governanceClassificationSchema,
  governanceHash,
} from '@agent-works/domain/data-governance';
import { describe, expect, it } from 'vitest';

import { createArtifactStore } from './artifact-store.js';
import { processDeletion, requestDeletion } from './deletion-requests.js';
import { changeLegalHold } from './holds.js';
import { revokeSource } from './source-revocation.js';
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
} from './test-fixtures.js';

describe('artifact authorization and intake', () => {
  it('checks owner, classification, region, source and current ACL evidence together', async () => {
    const { store } = await governanceFixture();
    await store.put(recordFixture(), SECRET);
    const good = readContext();
    expect(await store.read('artifact-1', good)).toBe(SECRET);
    for (const context of [
      { ...good, subject: 'bob' },
      { ...good, classificationCeiling: 'CONFIDENTIAL' as const },
      { ...good, allowedRegions: ['eu'] },
      { ...good, allowedSources: ['other'] },
      { ...good, aclEvidenceRefs: ['stale-acl'] },
      { ...good, aclEvidenceRefs: [] },
    ])
      expect(await store.read('artifact-1', context)).toBeUndefined();
  });
  it('enforces all label-ceiling combinations on actual encrypted reads', async () => {
    const { store } = await governanceFixture();
    const labels = governanceClassificationSchema.options;
    for (const [index, classification] of labels.entries()) {
      const id = `artifact-${index}`;
      await store.put({ ...recordFixture(id), classification }, SECRET);
      for (const [ceilingIndex, ceiling] of labels.entries()) {
        expect(await store.read(id, { ...readContext(), classificationCeiling: ceiling })).toBe(
          ceilingIndex >= index ? SECRET : undefined,
        );
      }
    }
  });
  it('expiry denies reads even before the retention sweeper runs', async () => {
    const { store, port, keys } = await governanceFixture();
    await store.put(recordFixture(), SECRET);
    const expired = createArtifactStore(port, keys, () => EXPIRED);
    expect(await expired.read('artifact-1', readContext())).toBeUndefined();
    expect((await port.snapshot()).artifacts).toHaveLength(1);
  });
  it('identical intake replay returns the original envelope and rejects changed identity', async () => {
    const { store, port } = await governanceFixture();
    const first = await store.put(recordFixture(), SECRET);
    expect(await store.put(recordFixture(), SECRET)).toEqual(first);
    await expect(
      store.put({ ...recordFixture(), classification: 'PUBLIC' }, SECRET),
    ).rejects.toThrow('reused');
    expect((await port.snapshot()).artifacts).toHaveLength(1);
  });
  it('a policy can be retried but never changed under an existing id', async () => {
    const { store } = await governanceFixture();
    await expect(store.policy(POLICY)).resolves.toBeUndefined();
    await expect(store.policy({ ...POLICY, ttlSeconds: 1 })).rejects.toThrow('immutable');
  });
  it('refuses unknown policies and forged expiry dates', async () => {
    const { store } = await governanceFixture();
    await expect(
      store.put({ ...recordFixture(), retentionClass: 'unknown' }, SECRET),
    ).rejects.toThrow('retention mismatch');
    await expect(
      store.put({ ...recordFixture(), expiresAt: '2027-01-01T00:00:00.000Z' }, SECRET),
    ).rejects.toThrow('retention mismatch');
  });
  it('deletion fences derived intake and reads before physical purge', async () => {
    const { port, store } = await governanceFixture();
    await store.put(recordFixture(), SECRET);
    await requestDeletion(
      port,
      { requestId: REQUEST_ID, subject: 'alice', reasonRef: 'case' },
      'officer',
      new Date(CREATED),
    );
    expect(await store.read('artifact-1', readContext())).toBeUndefined();
    await expect(store.derive('artifact-1', 'new', 'cache', SECRET)).rejects.toThrow('fence');
    await processDeletion(port, REQUEST_ID, 'officer', EXPIRED);
    await expect(store.put(recordFixture(), SECRET)).rejects.toThrow('deleted');
  });
  it('source revocation under hold keeps ciphertext but denies reads', async () => {
    const { port, store } = await governanceFixture();
    await store.put(recordFixture(), SECRET);
    await changeLegalHold(
      port,
      {
        commandId: HOLD_ID,
        target: { kind: 'source', id: 'source-1' },
        action: 'set',
        reasonRef: 'case',
      },
      'officer',
      new Date(CREATED),
    );
    expect(await revokeSource(port, 'source-1', 'officer', new Date(CREATED))).toEqual({
      purged: 0,
      held: 1,
    });
    expect((await port.snapshot()).artifacts).toHaveLength(1);
    expect(await store.read('artifact-1', readContext())).toBeUndefined();
    await expect(store.derive('artifact-1', 'derived', 'index', SECRET)).rejects.toThrow(
      'parent unavailable',
    );
  });
  it('derived payloads require a live parent and a unique id', async () => {
    const { store } = await governanceFixture();
    await expect(store.derive('absent', 'derived', 'index', SECRET)).rejects.toThrow(
      'parent unavailable',
    );
    await store.put(recordFixture(), SECRET);
    await store.derive('artifact-1', 'derived', 'index', SECRET);
    await expect(store.derive('artifact-1', 'derived', 'cache', SECRET)).rejects.toThrow('reused');
  });
  it('does not let a forged intake legalHold flag establish a hold', async () => {
    const { store } = await governanceFixture();
    const result = await store.put({ ...recordFixture(), legalHold: true }, SECRET);
    expect(result.record.legalHold).toBe(false);
    expect(result.record.canonicalHash).toBe(governanceHash(SECRET));
  });
});
