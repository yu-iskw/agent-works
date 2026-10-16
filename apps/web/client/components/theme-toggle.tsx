import { IconMoon, IconSun } from '@tabler/icons-react';
import { useState } from 'react';

import { applyTheme, persistTheme } from '../theme';

import type { Theme } from '../theme';

function readAppliedTheme(): Theme {
  return document.documentElement.classList.contains('dark') ? 'dark' : 'light';
}

export function ThemeToggle() {
  const [theme, setTheme] = useState(readAppliedTheme);

  function onToggle(): void {
    const next: Theme = theme === 'dark' ? 'light' : 'dark';
    applyTheme(next);
    persistTheme(next);
    setTheme(next);
  }

  const label = theme === 'dark' ? 'Switch to light theme' : 'Switch to dark theme';
  const Icon = theme === 'dark' ? IconSun : IconMoon;

  return (
    <button
      type="button"
      className="inline-flex size-8 items-center justify-center rounded-lg text-foreground hover:bg-muted"
      aria-label={label}
      onClick={onToggle}
    >
      <Icon size={16} aria-hidden="true" />
    </button>
  );
}
