import { describe, expect, it } from 'vitest';

import { DEFAULT_PREFERENCES } from '../../shared/contract.js';

import { preferencesFromRows, preferencesPatchSchema } from './preferences.js';

const T = '11111111-2222-4333-8444-555555555555';

describe('preferences rows', () => {
  it('fills defaults when nothing is stored', () => {
    expect(preferencesFromRows([], 'alpha')).toEqual(DEFAULT_PREFERENCES);
  });

  it("reads member-scope values and this segment's lastContext only", () => {
    const prefs = preferencesFromRows(
      [
        { scope: '*', key: 'theme', value: 'dark' },
        { scope: '*', key: 'sendKey', value: 'mod-enter' },
        { scope: '*', key: 'panelWidth', value: 640 },
        { scope: 'beta', key: 'lastContext', value: { teammateId: T, tab: 'work' } },
        { scope: 'alpha', key: 'lastContext', value: { teammateId: T, tab: 'results' } },
      ],
      'alpha',
    );
    expect(prefs).toEqual({
      theme: 'dark',
      startup: 'last',
      sendKey: 'mod-enter',
      panelWidth: 640,
      lastContext: { teammateId: T, tab: 'results' },
    });
  });

  it('treats an invalid or misplaced row as absent', () => {
    const prefs = preferencesFromRows(
      [
        { scope: '*', key: 'theme', value: 'sepia' },
        { scope: '*', key: 'panelWidth', value: 10 },
        { scope: 'alpha', key: 'theme', value: 'dark' },
        { scope: '*', key: 'lastContext', value: { teammateId: T, tab: 'work' } },
        { scope: '*', key: 'password', value: 'never' },
        { scope: 'alpha', key: 'lastContext', value: { teammateId: 'x', tab: 'work' } },
      ],
      'alpha',
    );
    expect(prefs).toEqual(DEFAULT_PREFERENCES);
  });
});

describe('preferences patch', () => {
  it('is closed: unknown keys and bad enums are rejected', () => {
    expect(preferencesPatchSchema.safeParse({ theme: 'light' }).success).toBe(true);
    expect(preferencesPatchSchema.safeParse({ theme: 'light', token: 'x' }).success).toBe(false);
    expect(preferencesPatchSchema.safeParse({ startup: 'recap' }).success).toBe(true);
    expect(preferencesPatchSchema.safeParse({ startup: 'home' }).success).toBe(false);
    expect(preferencesPatchSchema.safeParse({ panelWidth: 319 }).success).toBe(false);
    expect(preferencesPatchSchema.safeParse({ panelWidth: 320.5 }).success).toBe(false);
    expect(preferencesPatchSchema.safeParse({ lastContext: null }).success).toBe(true);
    expect(
      preferencesPatchSchema.safeParse({ lastContext: { teammateId: T, tab: 'inbox' } }).success,
    ).toBe(false);
  });
});
