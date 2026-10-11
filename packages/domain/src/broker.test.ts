import { describe, expect, it } from 'vitest';

import { approvalDecideSchema, ticketCreateManifest, toolManifestSchema } from './broker.js';

const digest = 'a'.repeat(64);

describe('broker contracts', () => {
  it('rejects an approval decision that omits the payload hash', () => {
    expect(approvalDecideSchema.safeParse({ decision: 'approve' }).success).toBe(false);
  });

  it('accepts a decision bound to a payload hash', () => {
    expect(
      approvalDecideSchema.parse({
        decision: 'approve',
        expectedPayloadSha256: digest,
      }),
    ).toEqual({
      decision: 'approve',
      expectedPayloadSha256: digest,
    });
  });

  it('accepts the ticket.create manifest', () => {
    expect(toolManifestSchema.parse(ticketCreateManifest)).toEqual(ticketCreateManifest);
  });
});
