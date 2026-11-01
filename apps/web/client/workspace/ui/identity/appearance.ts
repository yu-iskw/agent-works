// Identity resolution shared by every surface that draws a teammate: the sidebar, header, panel,
// mentions and cards all call `resolveAppearance`, so one teammate looks the same everywhere.

import { ACCENT_IDS, AVATAR_IDS } from '../../../../shared/contract.js';

import type { AccentId, Appearance, AvatarId } from '../../../../shared/contract.js';

export type ResolvedAppearance = { readonly avatar: AvatarId; readonly accent: AccentId };

function hash(text: string): number {
  let h = 0;
  for (let i = 0; i < text.length; i += 1) h = (h * 31 + text.charCodeAt(i)) >>> 0;
  return h;
}

/** A teammate without a chosen avatar or accent still gets its own, stable from its id alone. */
export function resolveAppearance(appearance: Appearance, id: string): ResolvedAppearance {
  const h = hash(id);
  return {
    avatar: appearance.avatar ?? AVATAR_IDS[h % AVATAR_IDS.length],
    accent: appearance.accent ?? ACCENT_IDS[Math.floor(h / AVATAR_IDS.length) % ACCENT_IDS.length],
  };
}

/** Up to two initials from the letters of a name or email; punctuation never leaks in. */
export function initialsOf(name: string): string {
  const words = name.split(/[^\p{L}\p{N}]+/u).filter((w) => w !== '');
  const letters = words
    .slice(0, 2)
    .map((w) => [...w][0] ?? '')
    .join('');
  return letters === '' ? '?' : letters.toUpperCase();
}
