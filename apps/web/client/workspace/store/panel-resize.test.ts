import { describe, expect, it } from 'vitest';

import { PANEL_WIDTH } from '../../../shared/contract.js';

import {
  CONVERSATION_MIN,
  RESIZE_STEP,
  clampPanelWidth,
  panelBounds,
  separatorKey,
  widthFromPointer,
} from './panel-resize.js';

describe('panel bounds', () => {
  it('leaves the conversation its minimum width', () => {
    expect(panelBounds(1440, 300)).toEqual({ min: 320, max: 1440 - 300 - CONVERSATION_MIN });
  });

  it('never exceeds the preference ceiling or drops below the floor', () => {
    expect(panelBounds(4000, 300).max).toBe(PANEL_WIDTH.max);
    expect(panelBounds(800, 300)).toEqual({ min: 320, max: 320 });
  });

  it('clamps widths and replaces non-numbers with the default', () => {
    const bounds = panelBounds(1440, 300);
    expect(clampPanelWidth(100, bounds)).toBe(320);
    expect(clampPanelWidth(5000, bounds)).toBe(bounds.max);
    expect(clampPanelWidth(500.4, bounds)).toBe(500);
    expect(clampPanelWidth(Number.NaN, bounds)).toBe(PANEL_WIDTH.default);
  });

  it('measures the pointer from the right edge', () => {
    expect(widthFromPointer(1000, 1440, panelBounds(1440, 300))).toBe(440);
    expect(widthFromPointer(1400, 1440, panelBounds(1440, 300))).toBe(320);
  });
});

describe('separator keys', () => {
  const bounds = panelBounds(1440, 300);

  it('moves by one step and clamps at the ends', () => {
    expect(separatorKey('ArrowLeft', 480, bounds)).toBe(480 + RESIZE_STEP);
    expect(separatorKey('ArrowUp', 480, bounds)).toBe(480 + RESIZE_STEP);
    expect(separatorKey('ArrowRight', 480, bounds)).toBe(480 - RESIZE_STEP);
    expect(separatorKey('ArrowDown', 480, bounds)).toBe(480 - RESIZE_STEP);
    expect(separatorKey('ArrowRight', 325, bounds)).toBe(320);
    expect(separatorKey('ArrowLeft', bounds.max - 3, bounds)).toBe(bounds.max);
  });

  it('jumps to the ends on Home and End and ignores other keys', () => {
    expect(separatorKey('Home', 480, bounds)).toBe(320);
    expect(separatorKey('End', 480, bounds)).toBe(bounds.max);
    expect(separatorKey('Enter', 480, bounds)).toBeUndefined();
  });
});
