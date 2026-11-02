// Panel width arithmetic shared by the pointer drag and the keyboard separator.

import { PANEL_WIDTH } from '../../../shared/contract.js';

/** The conversation column never goes narrower than this while the split is open. */
export const CONVERSATION_MIN = 360;
export const RESIZE_STEP = 16;

export type PanelBounds = { readonly min: number; readonly max: number };

/** The widest the panel may be in this viewport, given the sidebar's current width. */
export function panelBounds(viewportWidth: number, sideWidth: number): PanelBounds {
  const room = Math.floor(viewportWidth - sideWidth - CONVERSATION_MIN);
  return { min: PANEL_WIDTH.min, max: Math.max(PANEL_WIDTH.min, Math.min(PANEL_WIDTH.max, room)) };
}

export const clampPanelWidth = (width: number, bounds: PanelBounds): number =>
  Number.isFinite(width)
    ? Math.min(bounds.max, Math.max(bounds.min, Math.round(width)))
    : PANEL_WIDTH.default;

/** The panel sits on the right, so its width is the distance from the pointer to the right edge. */
export const widthFromPointer = (clientX: number, viewportWidth: number, bounds: PanelBounds) =>
  clampPanelWidth(viewportWidth - clientX, bounds);

/**
 * Keyboard operation of the separator. Left and Up widen the panel (the separator moves left),
 * Right and Down narrow it, Home is the narrowest and End the widest. Other keys do nothing.
 */
export function separatorKey(key: string, width: number, bounds: PanelBounds): number | undefined {
  switch (key) {
    case 'ArrowLeft':
    case 'ArrowUp':
      return clampPanelWidth(width + RESIZE_STEP, bounds);
    case 'ArrowRight':
    case 'ArrowDown':
      return clampPanelWidth(width - RESIZE_STEP, bounds);
    case 'Home':
      return bounds.min;
    case 'End':
      return bounds.max;
    default:
      return undefined;
  }
}
