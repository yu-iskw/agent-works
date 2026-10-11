import { describe, expect, it } from 'vitest';

import { contractReport, domainSchemaNames, schemaReport } from './schema-contract.js';

const f1SchemaNames = [
  'policy-decision.json',
  'search-context.json',
  'citation.json',
  'task-api.json',
  'outbox-event.json',
] as const;

describe('schema contract', () => {
  it('schemas.up-to-date', async () => {
    expect(domainSchemaNames).toEqual([
      'principal.json',
      'authority.json',
      'task.json',
      'approval.json',
      'tool-call.json',
      'audit-event.json',
      ...f1SchemaNames,
    ]);
    await expect(schemaReport(true)).resolves.toBe('11 schemas up to date');
  });

  it('contract.ask-response.up-to-date', async () => {
    await expect(contractReport(true)).resolves.toBe('1 api contract up to date');
  });
});
