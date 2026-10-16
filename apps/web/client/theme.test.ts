import { describe, expect, it } from 'vitest';

import { resolveTheme } from './theme';

import type { Theme } from './theme';

const cases: readonly {
  readonly stored: string | null;
  readonly prefersDark: boolean;
  readonly theme: Theme;
}[] = [
  { stored: 'dark', prefersDark: true, theme: 'dark' },
  { stored: 'dark', prefersDark: false, theme: 'dark' },
  { stored: 'light', prefersDark: true, theme: 'light' },
  { stored: 'light', prefersDark: false, theme: 'light' },
  { stored: 'other', prefersDark: true, theme: 'dark' },
  { stored: 'other', prefersDark: false, theme: 'light' },
  { stored: null, prefersDark: true, theme: 'dark' },
  { stored: null, prefersDark: false, theme: 'light' },
];

describe('resolveTheme', () => {
  it.each(cases)(
    'stored $stored with prefersDark $prefersDark resolves to $theme',
    ({ stored, prefersDark, theme }) => {
      expect(resolveTheme(stored, prefersDark)).toBe(theme);
    },
  );
});
