import { expect, it } from 'vitest';

import { runFinops } from './finops.js';

it('refuses a report without an explicit fixture', () => {
  const output: string[] = [];
  expect(
    runFinops(['report'], {
      write(body) {
        output.push(body);
      },
    }),
  ).toBe(1);
  expect(output.join('')).toContain('--fixture');
});
