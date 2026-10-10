import { describe, expect, it } from 'vitest';

import { schemaReport } from './schema-contract.js';

describe('schema contract', () => {
  it('schemas.up-to-date', async () => {
    await expect(schemaReport(true)).resolves.toBe('6 schemas up to date');
  });
});
