import { describe, expect, it } from 'vitest';

import { draftKey } from '../../shared/member-tag.js';

import { createDraftStore } from './storage.js';

import type { ContextChip } from '../../shared/composer.js';
import type { MemberTag } from '../../shared/member-tag.js';

const ALICE = '0123456789abcdef' as MemberTag;
const BOB = 'fedcba9876543210' as MemberTag;

function fakeStorage(): Storage {
  const map = new Map<string, string>();
  return {
    get length() {
      return map.size;
    },
    key: (i) => [...map.keys()].at(i) ?? null,
    getItem: (k) => map.get(k) ?? null,
    setItem: (k, v) => void map.set(k, v),
    removeItem: (k) => void map.delete(k),
    clear: () => map.clear(),
  };
}

const chip: ContextChip = {
  kind: 'source',
  source: 'drive_research',
  name: 'Drive research folder',
};
const ready: ContextChip = {
  kind: 'file',
  localId: 'f1',
  name: 'notes.md',
  mediaType: 'text/markdown',
  sizeBytes: 12,
  status: 'ready',
  attachmentId: 'a1',
  error: null,
  preview: 'first',
  lines: 1,
  sha256: 'abc',
};
const uploading: ContextChip = { ...ready, localId: 'f2', status: 'uploading', attachmentId: null };

describe('draft chips in storage', () => {
  it('persists chips with the text under the member, segment and conversation key', () => {
    const storage = fakeStorage();
    const store = createDraftStore(ALICE, 'alpha', () => storage);
    store.writeDraft('c1', { text: '', clientRequestId: 'r1', chips: [chip], target: null });
    expect(storage.getItem(draftKey(ALICE, 'alpha', 'c1'))).not.toBeNull();
    expect(store.readDraft('c1')).toEqual({
      text: '',
      clientRequestId: 'r1',
      chips: [chip],
      target: null,
    });
    expect(createDraftStore(BOB, 'alpha', () => storage).readDraft('c1')).toBeUndefined();
    expect(createDraftStore(ALICE, 'beta', () => storage).readDraft('c1')).toBeUndefined();
    expect(store.readDraft('c2')).toBeUndefined();
  });

  it('drops an interrupted upload on read and treats a chipless, textless draft as empty', () => {
    const storage = fakeStorage();
    const store = createDraftStore(ALICE, 'alpha', () => storage);
    store.writeDraft('c1', {
      text: '',
      clientRequestId: 'r1',
      chips: [ready, uploading],
      target: null,
    });
    expect(store.readDraft('c1')?.chips).toEqual([ready]);
    store.writeDraft('c1', { text: '', clientRequestId: 'r1', chips: [], target: null });
    expect(storage.getItem(draftKey(ALICE, 'alpha', 'c1'))).toBeNull();
  });

  it('reads drafts saved before chips existed', () => {
    const storage = fakeStorage();
    storage.setItem(draftKey(ALICE, 'alpha', 'c1'), '{"text":"old","clientRequestId":"r1"}');
    expect(createDraftStore(ALICE, 'alpha', () => storage).readDraft('c1')).toEqual({
      text: 'old',
      clientRequestId: 'r1',
      chips: [],
      target: null,
    });
  });

  it('purges the other member and clears only this segment on sign-out', () => {
    const storage = fakeStorage();
    createDraftStore(BOB, 'alpha', () => storage).writeDraft('c1', {
      text: 'bob',
      clientRequestId: null,
      chips: [chip],
      target: null,
    });
    const alice = createDraftStore(ALICE, 'alpha', () => storage);
    alice.writeDraft('c1', { text: 'alice', clientRequestId: null, chips: [chip], target: null });
    createDraftStore(ALICE, 'beta', () => storage).writeDraft('c1', {
      text: 'beta',
      clientRequestId: null,
      chips: [],
      target: null,
    });
    expect(alice.purgeOthers()).toBe(1);
    expect(storage.getItem(draftKey(BOB, 'alpha', 'c1'))).toBeNull();
    expect(alice.signOut()).toBe(2);
    expect(storage.getItem(draftKey(ALICE, 'beta', 'c1'))).toBeNull();
  });
});
