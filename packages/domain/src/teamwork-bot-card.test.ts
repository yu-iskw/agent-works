import { describe, expect, it } from 'vitest';

import { messageCardSchema } from './teamwork.js';

const teammateId = '11f91fcf-8795-4808-9b9c-5f9e7c3dcd76';
const card = {
  kind: 'bot_draft',
  teammateId,
  revision: 1,
  digest: 'a'.repeat(64),
  title: 'Bot design',
  outcome: 'draft',
};

describe('conversation cards', () => {
  it('accepts existing task cards and draft pointers', () => {
    expect(
      messageCardSchema.safeParse({ kind: 'task_created', taskId: teammateId, title: 'Task' })
        .success,
    ).toBe(true);
    expect(messageCardSchema.safeParse(card).success).toBe(true);
    expect(
      messageCardSchema.safeParse({
        ...card,
        revision: null,
        digest: null,
        outcome: 'needs_changes',
      }).success,
    ).toBe(true);
  });
  it('requires a revision and digest only on draft cards', () => {
    expect(messageCardSchema.safeParse({ ...card, revision: null }).success).toBe(false);
    expect(messageCardSchema.safeParse({ ...card, outcome: 'needs_changes' }).success).toBe(false);
  });
});
