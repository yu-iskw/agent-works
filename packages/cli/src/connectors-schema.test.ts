import { describe, expect, it } from 'vitest';

import { parseConnectorSummaries } from './connectors-schema.js';
describe('connector status response validation', () => {
  it.each([
    null,
    [],
    {},
    { connections: null },
    { connections: [null] },
    { connections: [{ provider: 1, scope: '', status: 'active' }] },
  ])('rejects malformed data %j', (value) => {
    expect(parseConnectorSummaries(value)).toBeUndefined();
  });
  it('extracts only safe summary fields', () => {
    expect(
      parseConnectorSummaries({
        connections: [{ provider: 'google', scope: 'read', status: 'active', token: 'SECRET' }],
      }),
    ).toEqual([{ provider: 'google', scope: 'read', status: 'active' }]);
  });
});
