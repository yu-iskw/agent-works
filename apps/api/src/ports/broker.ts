import type { ApprovalDecide, ApprovalDecided, BrokerReceipt } from '@agent-works/domain';

export interface BrokerPort {
  decide(approvalId: string, request: ApprovalDecide): Promise<ApprovalDecided>;
  putReceipt(receipt: BrokerReceipt): Promise<'stored' | 'replay'>;
  readReceipt(idempotencyKey: string): Promise<BrokerReceipt | undefined>;
}
