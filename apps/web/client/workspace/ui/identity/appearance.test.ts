import { describe, expect, it } from 'vitest';

import { ACCENT_IDS, AVATAR_IDS } from '../../../../shared/contract.js';

import { initialsOf, resolveAppearance } from './appearance.js';

describe('initialsOf', () => {
  it('takes letters only, so a parenthesised suffix or an email cannot leak punctuation', () => {
    expect(initialsOf('alice (local test)')).toBe('AL');
    expect(initialsOf('alice@local.test')).toBe('AL');
    expect(initialsOf('Business context researcher')).toBe('BC');
    expect(initialsOf('  Haru ')).toBe('H');
    expect(initialsOf('山田 太郎')).toBe('山太');
  });

  it('falls back to a question mark when there is nothing to draw', () => {
    expect(initialsOf('')).toBe('?');
    expect(initialsOf('(...)')).toBe('?');
  });
});

describe('resolveAppearance', () => {
  const none = { avatar: null, accent: null };

  it('keeps a chosen avatar and accent', () => {
    expect(resolveAppearance({ avatar: 'moon', accent: 'coral' }, 'x')).toEqual({
      avatar: 'moon',
      accent: 'coral',
    });
  });

  it('fills only the missing half', () => {
    const out = resolveAppearance({ avatar: 'moon', accent: null }, 'x');
    expect(out.avatar).toBe('moon');
    expect(ACCENT_IDS).toContain(out.accent);
  });

  it('is deterministic per teammate id and spreads across the curated set', () => {
    const ids = Array.from({ length: 40 }, (_, i) => `teammate-${i}`);
    const first = ids.map((id) => resolveAppearance(none, id));
    const again = ids.map((id) => resolveAppearance(none, id));
    expect(again).toEqual(first);
    expect(new Set(first.map((a) => a.avatar)).size).toBe(AVATAR_IDS.length);
    expect(new Set(first.map((a) => a.accent)).size).toBeGreaterThan(1);
  });
});
