// The menu model behind the composer: which menu is open, its rows, the active row, and what a
// pick or a key does. The component only renders and forwards events.

import { useState } from 'preact/hooks';

import {
  commandGroups,
  flatten,
  menuTrigger,
  mentionGroups,
  moveActive,
  plusGroups,
  removeTrigger,
} from '../../store/composer-menu.js';
import { activeDraft } from '../../store/selectors.js';

import type { FollowUpTarget } from '../../../../shared/composer.js';
import type { MenuAction, MenuGroup, MenuItem, MenuTrigger } from '../../store/composer-menu.js';
import type { Effects } from '../../store/effects.js';
import type { WorkspaceState } from '../../store/state.js';

type Menu =
  | { readonly kind: 'plus' }
  | {
      readonly kind: 'mention' | 'command';
      /** Null when opened from + ("Add source"); then no text is removed on pick. */
      readonly trigger: MenuTrigger | null;
      readonly query: string;
    };

const NAV_KEYS = new Set(['ArrowDown', 'ArrowUp', 'Home', 'End']);

export type MenuModel = {
  readonly menu: Menu | null;
  readonly groups: readonly MenuGroup[];
  readonly items: readonly MenuItem[];
  readonly activeItem: MenuItem | null;
  readonly active: number;
  readonly setActive: (index: number) => void;
  readonly openPlus: () => void;
  readonly close: () => void;
  /** Reads the text around the caret and opens, updates or closes a trigger menu. */
  readonly sync: (text: string, caret: number) => void;
  readonly pick: (item: MenuItem) => void;
  /** Returns true when the key was consumed by the menu. */
  readonly onKey: (event: KeyboardEvent) => boolean;
};

export type MenuDeps = {
  readonly state: WorkspaceState;
  readonly effects: Effects;
  readonly text: string;
  readonly candidates: readonly FollowUpTarget[];
  readonly openFilePicker: () => void;
  readonly focusArea: (caret?: number) => void;
  readonly focusPlus: () => void;
  readonly setCaret: (caret: number) => void;
  readonly askTarget: () => void;
};

function groupsFor(menu: Menu | null, deps: MenuDeps): readonly MenuGroup[] {
  const { state } = deps;
  const chips = activeDraft(state).chips;
  if (menu === null) return [];
  if (menu.kind === 'plus') return plusGroups({ readOnly: state.me.readOnly });
  if (menu.kind === 'mention') return mentionGroups(state.composer.context, menu.query, chips);
  return commandGroups(
    state.composer.context,
    menu.query,
    { currentTeammateId: state.conversation?.teammateId ?? null, targets: state.composer.targets },
    chips,
  );
}

export function useComposerMenu(deps: MenuDeps): MenuModel {
  const [menu, setMenu] = useState<Menu | null>(null);
  const [active, setActive] = useState(0);
  const { effects } = deps;
  const groups = groupsFor(menu, deps);
  const items = flatten(groups);
  const activeItem = items.at(active) ?? null;

  const open = (next: Menu) => {
    setMenu(next);
    setActive(0);
  };

  const close = (returnTo: 'area' | 'plus' = 'area') => {
    setMenu(null);
    setActive(0);
    if (returnTo === 'plus') deps.focusPlus();
    else deps.focusArea();
  };

  const sync = (text: string, caret: number) => {
    const trigger = menuTrigger(text, caret);
    if (trigger === null) {
      if (menu !== null && menu.kind !== 'plus' && menu.trigger !== null) setMenu(null);
      return;
    }
    if (menu === null || menu.kind !== trigger.kind || menu.query !== trigger.query)
      open({ kind: trigger.kind, trigger, query: trigger.query });
  };

  const stripTrigger = () => {
    if (menu === null || menu.kind === 'plus' || menu.trigger === null) return;
    const next = removeTrigger(deps.text, menu.trigger);
    deps.setCaret(next.caret);
    effects.setDraft(next.text);
  };

  const pickTarget = (kind: 'answer' | 'revise' | 'question') => {
    const matching = deps.candidates.filter((c) => c.kind === kind);
    if (matching.length === 1) effects.setTarget(matching[0]);
    else deps.askTarget();
  };

  const run = (action: MenuAction) => {
    switch (action.kind) {
      case 'attach-file':
        deps.openFilePicker();
        return;
      case 'add-source':
        open({ kind: 'mention', trigger: null, query: '' });
        deps.focusArea();
        return;
      case 'create-task':
        effects.openTaskDraft('manual');
        return;
      case 'ask-plan':
        effects.openTaskDraft('coordinated');
        return;
      case 'chip':
        stripTrigger();
        effects.addChip(action.chip);
        return;
      case 'command':
        stripTrigger();
        if (action.command === 'task' || action.command === 'plan')
          effects.openTaskDraft(action.command === 'task' ? 'manual' : 'coordinated');
        else pickTarget(action.command === 'ask' ? 'question' : action.command);
    }
  };

  const pick = (item: MenuItem) => {
    if (item.disabled !== null || menu === null) return;
    const wasPlus = menu.kind === 'plus';
    run(item.action);
    if (item.action.kind === 'add-source') return;
    close(wasPlus && item.action.kind === 'attach-file' ? 'plus' : 'area');
  };

  const onKey = (event: KeyboardEvent): boolean => {
    if (menu === null) return false;
    if (NAV_KEYS.has(event.key)) {
      event.preventDefault();
      setActive(moveActive(items.length, active, event.key));
      return true;
    }
    if (event.key === 'Escape') {
      event.preventDefault();
      close(menu.kind === 'plus' ? 'plus' : 'area');
      return true;
    }
    if (event.key !== 'Enter' && event.key !== 'Tab') return false;
    if (activeItem !== null && activeItem.disabled === null) {
      event.preventDefault();
      pick(activeItem);
      return true;
    }
    const swallow = menu.kind === 'plus' || menu.trigger === null;
    if (swallow) event.preventDefault();
    return swallow;
  };

  return {
    menu,
    groups,
    items,
    activeItem,
    active,
    setActive,
    openPlus: () => open({ kind: 'plus' }),
    close: () => close(menu?.kind === 'plus' ? 'plus' : 'area'),
    sync,
    pick,
    onKey,
  };
}
