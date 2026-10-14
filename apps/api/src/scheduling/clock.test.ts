import { expect, test } from 'vitest';

import { createFakeScheduleClock } from './clock.js';
test('fake clock advances deterministically and returns independent dates', () => {
  const clock = createFakeScheduleClock();
  const prior = clock.now();
  prior.setFullYear(2000);
  expect(clock.now().toISOString()).toBe('2026-10-14T10:00:00.000Z');
  clock.advance(60000);
  expect(clock.now().toISOString()).toBe('2026-10-14T10:01:00.000Z');
  clock.set('2026-10-15T00:00:00.000Z');
  expect(clock.now().getUTCDate()).toBe(15);
});
test.each([-1, 1.5, NaN, Infinity])('invalid clock delta %s', (delta) => {
  expect(() => createFakeScheduleClock().advance(delta)).toThrow();
});
