import type { BudgetLimits } from '@agent-works/domain/budget';
import type { DelegationEdge, DelegationAudit } from '@agent-works/domain/delegation';
export interface DelegationPort {
  /** Atomically reserve identity and cumulative parent allocation. Only the creator dispatches. */
  create(
    edge: DelegationEdge,
    parentShare: BudgetLimits,
  ): Promise<'created' | 'replay' | 'budget_share'>;
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
