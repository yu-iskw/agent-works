import type {
  DeletionRequest,
  DerivedRow,
  GovernanceAudit,
  GovernedArtifact,
  LegalHold,
  RetentionPolicy,
  Tombstone,
} from '@agent-works/domain/data-governance';

/** Transactions must serialize every governance write, including holds and intake.
 * A callback may run once; no network side effects belong inside it. */
export type GovernanceState = {
  policies: RetentionPolicy[];
  artifacts: GovernedArtifact[];
  derived: DerivedRow[];
  holds: LegalHold[];
  requests: DeletionRequest[];
  tombstones: Tombstone[];
  audit: GovernanceAudit[];
  revokedSources: string[];
};
export interface GovernancePort {
  snapshot(): Promise<GovernanceState>;
  transact<T>(operation: (state: GovernanceState) => T | Promise<T>): Promise<T>;
}
export class GovernanceConflict extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GovernanceConflict';
  }
}
export function emptyGovernanceState(): GovernanceState {
  return {
    policies: [],
    artifacts: [],
    derived: [],
    holds: [],
    requests: [],
    tombstones: [],
    audit: [],
    revokedSources: [],
  };
}
