// Eight original marks, drawn as simple geometry so they read at 24 px and at 64 px. The accent
// is the tile; the mark is the ink colour the tile declares.

import { resolveAppearance } from './identity/appearance.js';

import type { Appearance, AvatarId } from '../../../shared/contract.js';
import type { JSX } from 'preact';

export { initialsOf } from './identity/appearance.js';

const MARKS: Readonly<Record<AvatarId, JSX.Element>> = {
  leaf: (
    <g>
      <path d="M8 24c0-9 6-15 16-16-1 10-7 16-16 16z" fill="currentColor" />
      <path d="M9 23l9-9" stroke="var(--avatar-tile)" stroke-width="1.6" stroke-linecap="round" />
    </g>
  ),
  sun: (
    <g fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round">
      <circle cx="16" cy="16" r="5" fill="currentColor" stroke="none" />
      <path d="M16 5v3M16 24v3M5 16h3M24 16h3M8.2 8.2l2.1 2.1M21.7 21.7l2.1 2.1M8.2 23.8l2.1-2.1M21.7 10.3l2.1-2.1" />
    </g>
  ),
  moon: <path d="M20 7a9 9 0 1 0 5 16.5A8 8 0 0 1 20 7z" fill="currentColor" fill-rule="evenodd" />,
  wave: (
    <g fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round">
      <path d="M6 13c3-3 5-3 8 0s5 3 8 0 4-2 4-2" />
      <path d="M6 20c3-3 5-3 8 0s5 3 8 0 4-2 4-2" />
    </g>
  ),
  spark: <path d="M16 5l2.6 8.4L27 16l-8.4 2.6L16 27l-2.6-8.4L5 16l8.4-2.6z" fill="currentColor" />,
  stone: (
    <g>
      <path d="M8 18c0-6 5-10 11-10s7 5 6 10-5 7-10 7-7-2-7-7z" fill="currentColor" />
      <path
        d="M13 14c2-1 4-1 6 0"
        stroke="var(--avatar-tile)"
        stroke-width="1.6"
        stroke-linecap="round"
        fill="none"
      />
    </g>
  ),
  bloom: (
    <g fill="currentColor">
      <circle cx="16" cy="9" r="3.6" />
      <circle cx="22.7" cy="13.9" r="3.6" />
      <circle cx="20.1" cy="21.8" r="3.6" />
      <circle cx="11.9" cy="21.8" r="3.6" />
      <circle cx="9.3" cy="13.9" r="3.6" />
      <circle cx="16" cy="16" r="2.4" fill="var(--avatar-tile)" />
    </g>
  ),
  orbit: (
    <g fill="none" stroke="currentColor" stroke-width="2">
      <circle cx="16" cy="16" r="4.5" fill="currentColor" stroke="none" />
      <ellipse cx="16" cy="16" rx="11" ry="5" transform="rotate(-28 16 16)" />
      <circle cx="25" cy="10.5" r="1.8" fill="currentColor" stroke="none" />
    </g>
  ),
};

/** The mark alone, for pickers and previews that draw their own tile. */
export function AvatarMark(props: {
  readonly avatar: AvatarId;
  readonly size: number;
}): JSX.Element {
  return (
    <svg
      viewBox="0 0 32 32"
      width={props.size}
      height={props.size}
      aria-hidden="true"
      focusable="false"
    >
      {MARKS[props.avatar]}
    </svg>
  );
}

export function Avatar(props: {
  readonly appearance: Appearance;
  readonly id: string;
  readonly name: string;
  readonly size?: number;
}): JSX.Element {
  const size = props.size ?? 36;
  const { avatar, accent } = resolveAppearance(props.appearance, props.id);
  return (
    <span
      class="avatar"
      data-accent={accent}
      data-avatar={avatar}
      style={{ width: `${size}px`, height: `${size}px` }}
      role="img"
      aria-label={props.name}
    >
      <AvatarMark avatar={avatar} size={size} />
    </span>
  );
}
