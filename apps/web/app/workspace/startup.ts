import type { BootNotice, Preferences, TeammateRow } from '../../shared/contract.js';

export type StartupTarget =
  | { readonly kind: 'inbox' }
  | { readonly kind: 'teammate'; readonly id: string; readonly notice: BootNotice | null }
  | { readonly kind: 'empty' };

/** Where `/s/<seg>` lands. The recap startup is not built yet and behaves like last conversation. */
export function resolveStartup(
  prefs: Preferences,
  teammates: readonly TeammateRow[],
): StartupTarget {
  if (prefs.startup === 'inbox') return { kind: 'inbox' };
  const remembered = prefs.lastContext?.teammateId;
  if (remembered !== undefined && teammates.some((t) => t.id === remembered))
    return { kind: 'teammate', id: remembered, notice: null };
  const first = teammates.at(0);
  if (first === undefined) return { kind: 'empty' };
  return {
    kind: 'teammate',
    id: first.id,
    notice: remembered === undefined ? null : { code: 'remembered_teammate_gone' },
  };
}
