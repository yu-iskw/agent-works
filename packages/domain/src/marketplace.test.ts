import { describe, expect, it } from 'vitest';

import { MARKETPLACE_KINDS, marketplaceListingSchema } from './marketplace.js';

const listing = {
  kind: 'connector',
  id: 'google',
  version: '1.0.0',
  name: 'Google Workspace',
  summary: 'Read Drive and BigQuery.',
  publisher: 'agent-works',
  status: 'available',
} as const;

describe('marketplaceListingSchema', () => {
  it('lists the four kinds', () => {
    expect(MARKETPLACE_KINDS).toEqual(['connector', 'team_bot', 'mcp_server', 'a2a_agent']);
  });

  it('accepts a listing, with or without a relative href', () => {
    expect(marketplaceListingSchema.parse(listing)).toEqual(listing);
    expect(marketplaceListingSchema.parse({ ...listing, href: '/m1/templates' }).href).toBe(
      '/m1/templates',
    );
  });

  it.each([
    { extra: 1 },
    { kind: 'plugin' },
    { status: 'installed' },
    { version: 'latest' },
    { publisher: 'third-party' },
    { href: 'https://example.com' },
  ])('rejects %j', (patch) => {
    expect(marketplaceListingSchema.safeParse({ ...listing, ...patch }).success).toBe(false);
  });
});
