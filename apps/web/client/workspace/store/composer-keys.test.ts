import { describe, expect, it } from 'vitest';

import { nearBottom, scrollTopAfter } from './anchoring.js';
import { enterAction } from './composer-keys.js';
import { BACKOFF_MS, POLL_MS, nextDelay } from './scheduler.js';

import type { KeyFacts } from './composer-keys.js';

const key = (facts: Partial<KeyFacts>): KeyFacts => ({
  enter: true,
  shift: false,
  mod: false,
  composing: false,
  ...facts,
});

describe('enter policy', () => {
  it.each([
    ['enter', key({}), 'send'],
    ['enter', key({ shift: true }), 'newline'],
    ['enter', key({ mod: true }), 'send'],
    ['enter', key({ composing: true }), 'none'],
    ['enter', key({ composing: true, mod: true }), 'none'],
    ['enter', key({ enter: false }), 'none'],
    ['mod-enter', key({}), 'newline'],
    ['mod-enter', key({ shift: true }), 'newline'],
    ['mod-enter', key({ mod: true }), 'send'],
    ['mod-enter', key({ composing: true, mod: true }), 'none'],
  ] as const)('%s with %o -> %s', (sendKey, facts, expected) => {
    expect(enterAction(facts, sendKey)).toBe(expected);
  });
});

describe('poll scheduling', () => {
  it('polls every 2.5 s, backs off to 8 s after three failures and pauses while hidden', () => {
    expect(nextDelay(0, false)).toBe(POLL_MS);
    expect(nextDelay(2, false)).toBe(POLL_MS);
    expect(nextDelay(3, false)).toBe(BACKOFF_MS);
    expect(nextDelay(9, false)).toBe(BACKOFF_MS);
    expect(nextDelay(0, true)).toBeNull();
  });
});

describe('scroll anchoring', () => {
  it('follows only within 48 px of the bottom', () => {
    expect(nearBottom({ scrollTop: 952, clientHeight: 600, scrollHeight: 1600 })).toBe(true);
    expect(nearBottom({ scrollTop: 900, clientHeight: 600, scrollHeight: 1600 })).toBe(false);
  });

  it('pins to the bottom when following and keeps the reading offset otherwise', () => {
    const before = { scrollTop: 300, clientHeight: 600, scrollHeight: 1600 };
    expect(scrollTopAfter({ before, afterHeight: 2000, follow: true, addedAbove: 0 })).toBe(1400);
    expect(scrollTopAfter({ before, afterHeight: 2000, follow: false, addedAbove: 0 })).toBe(300);
    expect(scrollTopAfter({ before, afterHeight: 2000, follow: false, addedAbove: 250 })).toBe(550);
  });
});
