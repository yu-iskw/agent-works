import { expect, it } from 'vitest';

import { delegationEnabled } from './flag.js';
it.each([undefined, '', 'true', '1', 'ENABLED', 'disabled'])(
  'delegation defaults off for %s',
  (value) => {
    expect(delegationEnabled(value)).toBe(false);
  },
);
it('requires explicit offline operator opt-in', () => {
  expect(delegationEnabled('enabled')).toBe(true);
});
