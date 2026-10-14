import type { MemoryItem, MemoryConsent } from '@agent-works/domain/user-memory';
const createdAt = '2026-10-14T00:00:00.000Z';
export const webMemoryConsent: MemoryConsent = {
  tenant: 'tenant-a',
  owner: 'alice',
  enabled: true,
  revision: 1,
  noticeVersion: 'memory-v1',
  updatedAt: createdAt,
};
export function webMemoryItem(): MemoryItem {
  return {
    tenant: 'tenant-a',
    owner: 'alice',
    agent: 'default',
    id: '00000000-0000-4000-8000-000000000148',
    text: 'Prefer concise answers',
    classification: 'INTERNAL',
    ttlSeconds: 3600,
    origin: {
      kind: 'user-turn',
      subject: 'alice',
      taskId: 'task-1',
      turnId: 'turn-1',
      sourceRef: null,
    },
    revision: 1,
    createdAt,
    updatedAt: createdAt,
    expiresAt: '2026-10-14T01:00:00.000Z',
    legalHold: false,
    state: 'active',
  };
}
