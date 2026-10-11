import { describe, expect, it } from 'vitest';

import { duplicateDelivery, revokedSkill, runEval, timeoutAfterWrite } from './eval-run.js';

const ticket = {
  id: 'FAKE-1',
  summary: 'Checkout latency after dep-9',
  project: 'incidents',
  idempotencyKey: 'delivery-1',
};

describe('incident analysis', () => {
  it('duplicate-delivery', async () => {
    const result = await duplicateDelivery();
    expect(result).toEqual({
      first: { kind: 'written', ticketId: 'FAKE-1' },
      second: { kind: 'written', ticketId: 'FAKE-1' },
      tickets: [ticket],
    });
  });

  it('timeout-after-write', async () => {
    const result = await timeoutAfterWrite();
    expect(result).toEqual({
      first: { kind: 'timeout' },
      second: { kind: 'written', ticketId: 'FAKE-1' },
      tickets: [ticket],
    });
  });

  it('revoked-skill', async () => {
    const result = await revokedSkill();
    expect(result).toEqual({
      revoked: { kind: 'revoked' },
      ticketsAfterRevoke: [],
      published: { kind: 'written', ticketId: 'FAKE-1' },
    });
  });

  it('prints a score', async () => {
    const lines: string[] = [];
    const line = await runEval((text) => {
      lines.push(text);
    });
    expect(line).toBe('score 3/3');
    expect(lines).toEqual(['score 3/3']);
  });
});
