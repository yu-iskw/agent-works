const themeStorageKey = 'agent-works-theme';

export type Theme = 'light' | 'dark';

// index.html repeats this choice before paint. Keep the two copies in step.
export function resolveTheme(stored: string | null, prefersDark: boolean): Theme {
  if (stored === 'dark' || stored === 'light') {
    return stored;
  }
  return prefersDark ? 'dark' : 'light';
}

export function applyTheme(theme: Theme): void {
  document.documentElement.classList.toggle('dark', theme === 'dark');
}

export function persistTheme(theme: Theme): void {
  try {
    localStorage.setItem(themeStorageKey, theme);
  } catch {
    // Private mode can refuse storage. The class on the document still holds for this visit.
  }
}
