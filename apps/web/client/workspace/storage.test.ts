import { describe, expect, it } from 'vitest';

import { draftKey } from '../../shared/member-tag.js';

import { createDraftStore } from './storage.js';

import type { MemberTag } from '../../shared/member-tag.js';

const ALICE = '0123456789abcdef' as MemberTag;
const BOB = 'fedcba9876543210' as MemberTag;

function fakeStorage(initial: Record<string, string> = {}): Storage {
  const map = new Map(Object.entries(initial));
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

describe('draft store', () => {
  it('purges other members on boot and leaves its own drafts', () => {
    const storage = fakeStorage({
      [draftKey(BOB, 'alpha', 'c1')]: '{"text":"bob","clientRequestId":null}',
      [draftKey(ALICE, 'alpha', 'c1')]: '{"text":"alice","clientRequestId":"r1"}',
      'aw-m1:alpha:legacy': 'x',
    });
    const store = createDraftStore(ALICE, 'alpha', () => storage);
    expect(store.purgeOthers()).toBe(1);
    expect(storage.getItem(draftKey(BOB, 'alpha', 'c1'))).toBeNull();
    expect(store.readDraft('c1')).toEqual({ text: 'alice', clientRequestId: 'r1' });
    expect(storage.getItem('aw-m1:alpha:legacy')).toBe('x');
  });

  it('round-trips a draft, drops empty ones and ignores garbage', () => {
    const storage = fakeStorage({ [draftKey(ALICE, 'alpha', 'bad')]: '{nope' });
    const store = createDraftStore(ALICE, 'alpha', () => storage);
    store.writeDraft('c2', { text: 'hi', clientRequestId: 'r2' });
    expect(store.readDraft('c2')).toEqual({ text: 'hi', clientRequestId: 'r2' });
    store.writeDraft('c2', null);
    expect(store.readDraft('c2')).toBeUndefined();
    expect(store.readDraft('bad')).toBeUndefined();
  });

  it('clears only this member and segment on sign-out', () => {
    const storage = fakeStorage({
      [draftKey(ALICE, 'alpha', 'c1')]: '{"text":"a","clientRequestId":null}',
      [draftKey(ALICE, 'beta', 'c1')]: '{"text":"b","clientRequestId":null}',
    });
    expect(createDraftStore(ALICE, 'alpha', () => storage).clearMine()).toBe(1);
    expect(storage.getItem(draftKey(ALICE, 'beta', 'c1'))).not.toBeNull();
  });

  it('survives a storage that throws', () => {
    const store = createDraftStore(ALICE, 'alpha', () => {
      throw new Error('private window');
    });
    expect(store.purgeOthers()).toBe(0);
    expect(store.readDraft('c1')).toBeUndefined();
    expect(() => store.writeDraft('c1', { text: 'x', clientRequestId: null })).not.toThrow();
  });
});
