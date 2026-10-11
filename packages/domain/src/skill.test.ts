import { describe, expect, it } from 'vitest';

import { skillManifestSchema, skillPinSchema } from './skill.js';

describe('skill contracts', () => {
  it('pins incident-analysis at 1.0.0', () => {
    expect(skillPinSchema.parse({ id: 'incident-analysis', version: '1.0.0' })).toEqual({
      id: 'incident-analysis',
      version: '1.0.0',
    });
  });

  it('records a revoked skill', () => {
    expect(
      skillManifestSchema.parse({
        id: 'incident-analysis',
        version: '1.0.0',
        tools: ['ticket.create'],
        state: 'REVOKED',
      }),
    ).toEqual({
      id: 'incident-analysis',
      version: '1.0.0',
      tools: ['ticket.create'],
      state: 'REVOKED',
    });
  });
});
