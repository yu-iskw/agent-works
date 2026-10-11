import { approvalApiSchema, ticketCreateManifest, toolManifestSchema } from '@agent-works/domain';
import { describe, expect, it } from 'vitest';

import type { BrokerPort } from './broker.js';
import type { ApprovalDecide, BrokerReceipt } from '@agent-works/domain';

const digest = 'a'.repeat(64);
const otherDigest = 'b'.repeat(64);

const approve: ApprovalDecide = {
  decision: 'approve',
  expectedPayloadSha256: digest,
};

const receipt: BrokerReceipt = {
  toolCallId: 'call-1',
  idempotencyKey: 'key-1',
  externalReceipt: 'FAKE-1',
};

export function brokerPortContract(create: () => BrokerPort): void {
  describe('BrokerPort', () => {
    it('keeps the first decision for an approval id', async () => {
      const port = create();
      const decided = await port.decide('apr-1', approve);
      expect(approvalApiSchema.parse({ kind: 'decided', ...decided })).toEqual({
        kind: 'decided',
        id: 'apr-1',
        state: 'approved',
        executionsUsed: 0,
      });
      expect(
        await port.decide('apr-1', { decision: 'reject', expectedPayloadSha256: otherDigest }),
      ).toEqual({
        id: 'apr-1',
        state: 'approved',
        executionsUsed: 0,
      });
    });

    it('publishes the ticket.create manifest', () => {
      expect(toolManifestSchema.parse(ticketCreateManifest)).toMatchObject({
        metadata: { name: 'ticket.create' },
        spec: { sideEffect: 'WRITE_LOW', approval: { required: true } },
      });
    });

    it('stores a receipt once and replays the same key', async () => {
      const port = create();
      expect(await port.putReceipt(receipt)).toBe('stored');
      expect(
        await port.putReceipt({ ...receipt, externalReceipt: 'FAKE-2', toolCallId: 'call-2' }),
      ).toBe('replay');
      expect(await port.readReceipt('key-1')).toEqual(receipt);
      expect(await port.readReceipt('missing')).toBeUndefined();
    });
  });
}
