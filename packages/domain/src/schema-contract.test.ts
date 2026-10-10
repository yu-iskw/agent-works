import { describe, expect, it } from 'vitest';

import { contractReport, schemaReport } from './schema-contract.js';

describe('schema contract', () => {
  it('schemas.up-to-date', async () => {
    await expect(schemaReport(true)).resolves.toBe('6 schemas up to date');
  });

  it('contract.ask-response.up-to-date', async () => {
    await expect(contractReport(true)).resolves.toBe('1 api contract up to date');
  });
});
