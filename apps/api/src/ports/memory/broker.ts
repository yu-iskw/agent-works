import {
  approvalDecideSchema,
  approvalDecidedSchema,
  brokerReceiptSchema,
} from '@agent-works/domain';

import type { BrokerPort } from '../broker.js';
import type { ApprovalDecide, ApprovalDecided, BrokerReceipt } from '@agent-works/domain';

export function createMemoryBrokerPort(): BrokerPort {
  const decisions = new Map<string, ApprovalDecided>();
  const receipts = new Map<string, BrokerReceipt>();
  return {
    decide(approvalId, request) {
      const parsed = approvalDecideSchema.parse(request);
      const existing = decisions.get(approvalId);
      if (existing !== undefined) return Promise.resolve(existing);
      const decided = approvalDecidedSchema.parse({
        id: approvalId,
        state: outcome(parsed.decision),
        executionsUsed: 0,
      });
      decisions.set(approvalId, decided);
      return Promise.resolve(decided);
    },
    putReceipt(receipt) {
      const parsed = brokerReceiptSchema.parse(receipt);
      if (receipts.has(parsed.idempotencyKey)) return Promise.resolve('replay');
      receipts.set(parsed.idempotencyKey, parsed);
      return Promise.resolve('stored');
    },
    readReceipt(idempotencyKey) {
      return Promise.resolve(receipts.get(idempotencyKey));
    },
  };
}

function outcome(decision: ApprovalDecide['decision']): ApprovalDecided['state'] {
  switch (decision) {
    case 'approve':
      return 'approved';
    case 'reject':
      return 'rejected';
    default: {
      const unreachable: never = decision;
      return unreachable;
    }
  }
}
