import { expect, it } from 'vitest';

import { parseDlqArgs, runDlq } from './dlq.js';

it.each(['list', 'requeue', 'compensate'] as const)(
  'registers separate offline %s review',
  (action) => {
    expect(parseDlqArgs([action, '--fixture', 'fixture.json'])).toEqual({
      action,
      file: 'fixture.json',
    });
  },
);
it('refuses unknown commands, missing fixture and silent write replay', () => {
  expect(() => parseDlqArgs(['replay', '--fixture', 'fixture.json'])).toThrow();
  expect(() => parseDlqArgs(['requeue'])).toThrow();
  const output: string[] = [];
  expect(
    runDlq(['requeue'], {
      write(body) {
        output.push(body);
      },
    }),
  ).toBe(1);
  expect(output.join('')).toContain('explicit review evidence');
});
