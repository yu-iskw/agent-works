import { POLICY_CLAUSES, canonicalPayloadSha256 } from '@agent-works/domain';
import { decide } from '@agent-works/policy';
import { expect, test, vi } from 'vitest';

import { createMemoryApprovalStore } from '../broker/approvals.js';
import { createBroker, TICKET_TOOL } from '../broker/broker.js';
import { createMemoryLedgerPort } from '../ports/memory/ledger-port.js';
import { createMemorySuspensionLedger } from '../ports/memory/suspension-ledger.js';

import { createSuspensionEnforcer } from './enforcement.js';
import {
  publishPins,
  suspendCommand,
  testAt,
  testContext,
  versionCommand,
} from './test-fixtures.js';

import type { ExecuteInput } from '../broker/broker.js';

const payload = { summary: 'Fix incident', project: 'incidents' };
const input: ExecuteInput = {
  id: 'call-1',
  taskId: 'task-1',
  stepId: 'ticket',
  toolRef: TICKET_TOOL,
  idempotencyKey: 'key-1',
  targetResource: 'incidents',
  payload,
  approvalId: 'approval-1',
  actorSub: 'alice',
  traceId: 'trace-1',
  facts: Object.fromEntries(POLICY_CLAUSES.map((clause) => [clause, true])),
};
async function world() {
  const control = createMemorySuspensionLedger();
  await publishPins(control);
  const enforce = createSuspensionEnforcer({ ledger: control, now: () => testAt });
  const store = createMemoryApprovalStore();
  await store.save({
    id: input.approvalId,
    taskId: input.taskId,
    stepId: input.stepId,
    tool: TICKET_TOOL,
    targetResource: 'incidents',
    payloadSha256: canonicalPayloadSha256(payload),
    requestedBySub: 'alice',
    approverSub: 'bob',
    state: 'approved',
    expiresAt: '2099-01-01T00:00:00.000Z',
    maxExecutions: 1,
    executionsUsed: 0,
  });
  const postTicket = vi.fn().mockResolvedValue('receipt-1');
  const beforeToolCall = vi.fn(() => enforce.check(testContext, 'tool'));
  const ledger = createMemoryLedgerPort(() => testAt);
  const broker = createBroker({
    store,
    ledger,
    decide,
    postTicket,
    beforeToolCall,
    approverAuthorized: () => true,
    now: () => testAt,
  });
  return { control, broker, postTicket, beforeToolCall, ledger };
}
test('broker injected hook denies a tool before external side effects and writes denial audit', async () => {
  const app = await world();
  await app.control.change(
    suspendCommand({ scope: 'global', id: '*', version: null }),
    'operator',
    testAt,
  );
  await expect(app.broker.execute(input)).rejects.toThrow('INVOCATION_SUSPENDED');
  expect(app.postTicket).not.toHaveBeenCalled();
  expect(app.beforeToolCall).toHaveBeenCalledExactlyOnceWith(input);
  expect(
    (await app.control.history()).filter((event) => event.eventType === 'invocation.denied'),
  ).toHaveLength(1);
  expect(await app.ledger.readOutbox(`intended:${input.id}`)).toMatchObject({
    event: { outcome: 'INTENDED' },
  });
});
test('completed receipt is returned after revocation without replaying side effects', async () => {
  const app = await world();
  expect(await app.broker.execute(input)).toEqual({
    ok: true,
    receipt: 'receipt-1',
    replay: false,
  });
  await app.control.change(versionCommand(testContext.skill, 'revoked', 2), 'operator', testAt);
  expect(await app.broker.execute(input)).toEqual({ ok: true, receipt: 'receipt-1', replay: true });
  expect(app.postTicket).toHaveBeenCalledOnce();
  expect(app.beforeToolCall).toHaveBeenCalledOnce();
});
test('new call is denied when store becomes unreachable after a prior completed call', async () => {
  const app = await world();
  await app.broker.execute(input);
  app.control.snapshot = () => Promise.reject(new Error('unreachable'));
  // A separate intended call still cannot reach the transport, even with an approved payload.
  const store = createMemoryApprovalStore();
  await store.save({
    id: 'approval-2',
    taskId: 'task-2',
    stepId: 'ticket',
    tool: TICKET_TOOL,
    targetResource: 'incidents',
    payloadSha256: canonicalPayloadSha256(payload),
    requestedBySub: 'alice',
    approverSub: 'bob',
    state: 'approved',
    expiresAt: '2099-01-01T00:00:00.000Z',
    maxExecutions: 1,
    executionsUsed: 0,
  });
  const second = createBroker({
    store,
    ledger: app.ledger,
    decide,
    postTicket: app.postTicket,
    beforeToolCall: app.beforeToolCall,
    approverAuthorized: () => true,
    now: () => testAt,
  });
  await expect(
    second.execute({
      ...input,
      id: 'call-2',
      taskId: 'task-2',
      approvalId: 'approval-2',
      idempotencyKey: 'key-2',
    }),
  ).rejects.toThrow('SUSPENSION_STORE_UNAVAILABLE');
  expect(app.postTicket).toHaveBeenCalledOnce();
});
