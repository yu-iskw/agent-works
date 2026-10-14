import { randomUUID } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import {
  memoryConsentCommandSchema,
  memoryItemSchema,
  memoryProposalSchema,
  memoryScopeSchema,
  memoryEditSchema,
  memoryNotice,
} from './user-memory.js';
const proposal = {
  id: randomUUID(),
  text: 'Prefer short answers',
  classification: 'INTERNAL',
  ttlSeconds: 3600,
  origin: { kind: 'user-turn', subject: 'alice', taskId: 'task', turnId: 'turn', sourceRef: null },
};
describe('user memory domain contracts', () => {
  it('publishes the opt-in lifecycle notice', () => {
    expect(memoryNotice).toContain('optional');
    expect(memoryNotice).toContain('own turns');
    expect(memoryNotice).toContain('legal holds');
  });
  it('requires an explicit tuple scope', () => {
    expect(memoryScopeSchema.parse({ tenant: 't', owner: 'a', agent: 'helper' })).toEqual({
      tenant: 't',
      owner: 'a',
      agent: 'helper',
    });
    expect(memoryScopeSchema.safeParse({ owner: 'a', agent: 'helper' }).success).toBe(false);
  });
  it.each(['tenant', 'owner', 'agent'])('rejects empty %s', (key) => {
    expect(
      memoryScopeSchema.safeParse({ tenant: 't', owner: 'a', agent: 'helper', [key]: '' }).success,
    ).toBe(false);
  });
  it.each([0, -1, 59, 31536001, Infinity, NaN, 60.5])('rejects invalid TTL %s', (ttlSeconds) => {
    expect(memoryProposalSchema.safeParse({ ...proposal, ttlSeconds }).success).toBe(false);
  });
  it.each([60, 3600, 31536000])('accepts bounded TTL %s', (ttlSeconds) => {
    expect(memoryProposalSchema.safeParse({ ...proposal, ttlSeconds }).success).toBe(true);
  });
  it('accepts RESTRICTED as a proposal label but never as a stored item', () => {
    expect(
      memoryProposalSchema.safeParse({ ...proposal, classification: 'RESTRICTED' }).success,
    ).toBe(true);
    expect(
      memoryItemSchema.safeParse({
        ...proposal,
        classification: 'RESTRICTED',
        tenant: 't',
        owner: 'alice',
        agent: 'a',
        revision: 1,
        createdAt: '2026-10-14T00:00:00.000Z',
        updatedAt: '2026-10-14T00:00:00.000Z',
        expiresAt: '2026-10-14T01:00:00.000Z',
        legalHold: false,
        state: 'active',
      }).success,
    ).toBe(false);
  });
  it.each(['retrieved-document', 'assistant', 'system', 'tool-result'])(
    'rejects origin kind %s',
    (kind) => {
      expect(
        memoryProposalSchema.safeParse({ ...proposal, origin: { ...proposal.origin, kind } })
          .success,
      ).toBe(false);
    },
  );
  it('rejects hidden authority fields in proposal and scope', () => {
    expect(memoryProposalSchema.safeParse({ ...proposal, roles: ['admin'] }).success).toBe(false);
    expect(
      memoryScopeSchema.safeParse({ tenant: 't', owner: 'a', agent: 'helper', subject: 'b' })
        .success,
    ).toBe(false);
  });
  it('requires a known notice version before consent', () => {
    expect(
      memoryConsentCommandSchema.safeParse({ enabled: true, revision: 0, noticeVersion: 'old' })
        .success,
    ).toBe(false);
    expect(memoryConsentCommandSchema.safeParse({ enabled: true, revision: 0 }).success).toBe(
      false,
    );
  });
  it('requires a revision and forbids provenance edits', () => {
    expect(
      memoryEditSchema.safeParse({ id: proposal.id, agent: 'a', revision: 1, text: 'updated' })
        .success,
    ).toBe(true);
    expect(
      memoryEditSchema.safeParse({ id: proposal.id, agent: 'a', text: 'updated' }).success,
    ).toBe(false);
    expect(
      memoryEditSchema.safeParse({
        id: proposal.id,
        agent: 'a',
        revision: 1,
        text: 'updated',
        origin: proposal.origin,
      }).success,
    ).toBe(false);
  });
});
