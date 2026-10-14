import type {
  MemoryAudit,
  MemoryConsent,
  MemoryItem,
  MemoryScope,
  MemoryTombstone,
} from '@agent-works/domain/user-memory';
export class MemoryConflict extends Error {
  constructor(message = 'memory conflict') {
    super(message);
    this.name = 'MemoryConflict';
  }
}
export class MemoryDenied extends Error {
  constructor() {
    super('memory disabled or provenance denied');
    this.name = 'MemoryDenied';
  }
}
export type MemoryState = {
  consents: MemoryConsent[];
  items: MemoryItem[];
  history: MemoryItem[];
  audit: MemoryAudit[];
  tombstones: MemoryTombstone[];
  revokedSources: string[];
};
export interface MemoryStore {
  /** Governed stores supply a current hold resolver under the governance lock. */
  transaction<T>(
    operation: (state: MemoryState, isHeld?: (row: MemoryItem) => boolean) => T,
  ): Promise<T>;
}
export type MemoryPolicy = {
  tenantEnabled: (tenant: string) => Promise<boolean>;
  sourceAllowed: (scope: MemoryScope, sourceRef: string) => Promise<boolean>;
  now: () => Date;
};
export function emptyMemoryState(): MemoryState {
  return { consents: [], items: [], history: [], audit: [], tombstones: [], revokedSources: [] };
}
