import { expect, test } from 'vitest';

import { parseCron, validCron, cronMatches } from './schedule-cron.js';
test.each(['* * * * *', '*/15 9-17 * * 1-5', '0 0 1,15 * *', '0 0 29 2 *', '5/10 * * * *'])(
  'valid cron %s',
  (expression) => {
    expect(validCron(expression)).toBe(true);
  },
);
test.each([
  '',
  '* * * *',
  '* * * * * *',
  '60 * * * *',
  '* 24 * * *',
  '* * 0 * *',
  '* * * 13 *',
  '* * * * 7',
  '*/0 * * * *',
  '*/99 * * * *',
  '17-1 * * * *',
  '@daily',
  'foo * * * *',
  '1,,2 * * * *',
  '1/2/3 * * * *',
])('invalid cron %s', (expression) => {
  expect(validCron(expression)).toBe(false);
  expect(() => parseCron(expression)).toThrow();
});
test('cron uses standard OR semantics for restricted day-of-month and weekday', () => {
  const cron = parseCron('0 9 15 * 1');
  expect(cronMatches(cron, [0, 9, 15, 10, 3])).toBe(true);
  expect(cronMatches(cron, [0, 9, 14, 10, 1])).toBe(true);
  expect(cronMatches(cron, [0, 9, 14, 10, 3])).toBe(false);
});
test('wildcard weekday requires the restricted month day', () => {
  expect(cronMatches(parseCron('0 9 15 * *'), [0, 9, 14, 10, 1])).toBe(false);
});
test('steps and lists match expected minutes', () => {
  const cron = parseCron('0,15,30,45 9-17 * * 1-5');
  expect(cronMatches(cron, [15, 10, 14, 10, 3])).toBe(true);
  expect(cronMatches(cron, [16, 10, 14, 10, 3])).toBe(false);
  expect(cronMatches(cron, [15, 18, 14, 10, 3])).toBe(false);
});
