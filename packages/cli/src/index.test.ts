import { describe, expect, it } from 'vitest';

import { run } from './index.js';

describe('run', () => {
  it('throws', () => {
    expect(() => run()).toThrow('not implemented');
  });
});
