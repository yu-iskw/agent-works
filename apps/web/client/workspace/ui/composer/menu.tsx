// One listbox for the +, @ and / menus: grouped options, an active row the owner moves, disabled
// rows that keep their reason readable, and pointer picks that never steal the textarea's focus.

import { Avatar } from '../avatars.jsx';

import type { MenuGroup, MenuItem } from '../../store/composer-menu.js';
import type { JSX } from 'preact';

const optionId = (menuId: string, item: MenuItem): string => `${menuId}-${item.id}`;

export function MenuList(props: {
  readonly id: string;
  readonly label: string;
  readonly groups: readonly MenuGroup[];
  readonly active: number;
  readonly emptyText: string;
  readonly onPick: (item: MenuItem) => void;
  readonly onHover: (index: number) => void;
  /** Set when the listbox itself takes focus (the + menu); trigger menus keep focus in the textarea. */
  readonly focusable?: {
    readonly onKeyDown: (event: KeyboardEvent) => void;
    readonly ref: (node: HTMLDivElement | null) => void;
  };
}): JSX.Element {
  let index = -1;
  const empty = props.groups.every((group) => group.items.length === 0);
  return (
    <div
      id={props.id}
      class="menu cm"
      role="listbox"
      aria-label={props.label}
      tabIndex={0}
      ref={props.focusable?.ref}
      onKeyDown={props.focusable?.onKeyDown}
      aria-activedescendant={
        props.focusable === undefined || props.active < 0
          ? undefined
          : optionId(props.id, props.groups.flatMap((g) => g.items)[props.active])
      }
    >
      {empty ? (
        <p class="cm-empty" role="option" aria-selected="false" aria-disabled="true">
          {props.emptyText}
        </p>
      ) : (
        props.groups.map((group) =>
          group.items.length === 0 ? null : (
            <div role="group" aria-label={group.label} key={group.label} class="cm-group">
              <span class="cm-group-label" aria-hidden="true">
                {group.label}
              </span>
              {group.items.map((item) => {
                index += 1;
                const row = index;
                const off = item.disabled !== null;
                return (
                  <div
                    key={item.id}
                    id={optionId(props.id, item)}
                    role="option"
                    aria-selected={row === props.active}
                    aria-disabled={off ? 'true' : undefined}
                    class={`cm-item${row === props.active ? ' cm-active' : ''}${off ? ' cm-off' : ''}`}
                    onMouseDown={(event) => event.preventDefault()}
                    onMouseEnter={() => props.onHover(row)}
                    onClick={() => {
                      if (!off) props.onPick(item);
                    }}
                  >
                    {item.avatar === null ? null : (
                      <Avatar
                        appearance={item.avatar.appearance}
                        id={item.avatar.id}
                        name={item.avatar.name}
                        size={24}
                      />
                    )}
                    <span class="cm-text">
                      <span class="cm-label">{item.label}</span>
                      {off ? (
                        <span class="cm-reason">{item.disabled}</span>
                      ) : item.hint === null ? null : (
                        <span class="cm-hint">{item.hint}</span>
                      )}
                    </span>
                  </div>
                );
              })}
            </div>
          ),
        )
      )}
    </div>
  );
}
