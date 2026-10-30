import { describe, expect, it } from 'vitest';

import { clearDrafts, draftKey, isMemberTag, purgeOtherMembers, storageKey } from './member-tag.js';

import type { KeyStore, MemberTag } from './member-tag.js';

const ALICE = '0123456789abcdef' as MemberTag;
const BOB = 'fedcba9876543210' as MemberTag;

function store(initial: readonly string[]): KeyStore & { readonly keys: () => readonly string[] } {
  const keys = [...initial];
  return {
    get length() {
      return keys.length;
    },
    key: (i) => keys.at(i) ?? null,
    removeItem: (key) => {
      const at = keys.indexOf(key);
      if (at !== -1) keys.splice(at, 1);
    },
    keys: () => keys,
  };
}

describe('member tag storage', () => {
  it('accepts only 16 lowercase hex characters', () => {
    expect(isMemberTag('0123456789abcdef')).toBe(true);
    expect(isMemberTag('0123456789ABCDEF')).toBe(false);
    expect(isMemberTag('0123456789abcde')).toBe(false);
    expect(isMemberTag('local-test:alice')).toBe(false);
  });

  it('builds keys under the aw prefix', () => {
    expect(storageKey(ALICE, 'alpha', 'sidebar', 'tab')).toBe(`aw:${ALICE}:alpha:sidebar:tab`);
    expect(draftKey(ALICE, 'beta', 'conv-1')).toBe(`aw:${ALICE}:beta:draft:conv-1`);
  });

  it('purges every other member and leaves foreign keys alone', () => {
    const s = store([
      draftKey(ALICE, 'alpha', 'c1'),
      draftKey(BOB, 'alpha', 'c1'),
      draftKey(BOB, 'beta', 'c2'),
      storageKey(ALICE, 'beta', 'sidebar'),
      'aw-m1:alpha:conv-x',
      'unrelated',
    ]);
    expect(purgeOtherMembers(s, ALICE)).toBe(2);
    expect(s.keys()).toEqual([
      draftKey(ALICE, 'alpha', 'c1'),
      storageKey(ALICE, 'beta', 'sidebar'),
      'aw-m1:alpha:conv-x',
      'unrelated',
    ]);
  });

  it('clears only the drafts of one member in one segment', () => {
    const s = store([
      draftKey(ALICE, 'alpha', 'c1'),
      draftKey(ALICE, 'alpha', 'c2'),
      draftKey(ALICE, 'beta', 'c3'),
      storageKey(ALICE, 'alpha', 'sidebar'),
      draftKey(BOB, 'alpha', 'c1'),
    ]);
    expect(clearDrafts(s, ALICE, 'alpha')).toBe(2);
    expect(s.keys()).toEqual([
      draftKey(ALICE, 'beta', 'c3'),
      storageKey(ALICE, 'alpha', 'sidebar'),
      draftKey(BOB, 'alpha', 'c1'),
    ]);
  });
});
