import type { BootNotice, Preferences, TeammateRow } from '../../shared/contract.js';
import type { PanelRoute } from '../../shared/route.js';

export type StartupTarget =
  | {
      readonly kind: 'teammate';
      readonly id: string;
      readonly panel: PanelRoute;
      readonly notice: BootNotice | null;
    }
  | { readonly kind: 'empty' };

const STARTUP_PANEL: Readonly<Record<Preferences['startup'], PanelRoute>> = {
  last: { kind: 'none' },
  inbox: { kind: 'inbox' },
  recap: { kind: 'recap' },
};

/**
 * Where `/s/<seg>` lands: the last accessible conversation, with the inbox or the recap panel
 * open on top when the member chose those startup views. The conversation behind the panel is the
 * remembered one, so Back always has somewhere to go.
 */
export function resolveStartup(
  prefs: Preferences,
  teammates: readonly TeammateRow[],
): StartupTarget {
  const panel = STARTUP_PANEL[prefs.startup];
  const remembered = prefs.lastContext?.teammateId;
  if (remembered !== undefined && teammates.some((t) => t.id === remembered))
    return { kind: 'teammate', id: remembered, panel, notice: null };
  const first = teammates.at(0);
  if (first === undefined) return { kind: 'empty' };
  return {
    kind: 'teammate',
    id: first.id,
    panel,
    notice: remembered === undefined ? null : { code: 'remembered_teammate_gone' },
  };
}
