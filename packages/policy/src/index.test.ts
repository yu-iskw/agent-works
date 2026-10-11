import { describe, expect, it } from 'vitest';

import { decide } from './index.js';

describe('decide', () => {
  it('throws', () => {
    expect(() => decide()).toThrow('not implemented');
  });
});
