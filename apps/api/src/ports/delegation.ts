import type {
  DelegationEdge,
  DelegationAudit,
} from '../../../../packages/domain/dist/delegation.js';
export interface DelegationPort {
  /** One parent per child; reject identity conflicts. No child result body is stored. */
  create(edge: DelegationEdge): Promise<void>;
  settle(
    childTaskId: string,
    state: 'verified' | 'rejected' | 'failed',
    resultDigest: string | null,
    verifierRef: string | null,
  ): Promise<void>;
  read(childTaskId: string): Promise<DelegationEdge | undefined>;
  children(parentTaskId: string): Promise<readonly DelegationEdge[]>;
  audit(event: DelegationAudit): Promise<void>;
  audits(parentTaskId: string): Promise<readonly DelegationAudit[]>;
}
