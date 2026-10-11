import { pathToFileURL } from 'node:url';

import { canonicalPayloadSha256 } from '@agent-works/domain';
import { decide } from '@agent-works/policy';

import { createMemoryLedgerPort } from '../ports/memory/ledger-port.js';

import { createMemoryApprovalStore } from './approvals.js';
import { allowedFacts } from './broker-harness.js';
import { TICKET_TOOL, createBroker } from './broker.js';

export const BROKER_BUDGET_MS = 60;

const samples = 40;
const warmup = 10;
const now = new Date('2026-10-11T12:00:00.000Z');
const payload = { summary: 'Ship the fix', project: 'PROJ' };

export async function measureBroker(): Promise<number> {
  const store = createMemoryApprovalStore();
  const digest = canonicalPayloadSha256(payload);
  let tickets = 0;
  const broker = createBroker({
    store,
    decide,
    ledger: createMemoryLedgerPort(() => now),
    approverAuthorized: () => true,
    now: () => now,
    postTicket() {
      tickets += 1;
      return Promise.resolve(`FAKE-${tickets}`);
    },
  });
  const total = warmup + samples;
  for (let index = 0; index < total; index += 1) {
    await store.save({
      id: `apr-${index}`,
      taskId: `tsk-${index}`,
      stepId: 'step-1',
      tool: TICKET_TOOL,
      targetResource: 'PROJ',
      payloadSha256: digest,
      requestedBySub: 'alice',
      approverSub: 'bob',
      state: 'approved',
      expiresAt: '2026-12-01T00:00:00.000Z',
      maxExecutions: 1,
      executionsUsed: 0,
    });
  }
  const durations: number[] = [];
  for (let index = 0; index < total; index += 1) {
    const started = performance.now();
    const result = await broker.execute({
      id: `call-${index}`,
      taskId: `tsk-${index}`,
      stepId: 'step-1',
      toolRef: TICKET_TOOL,
      idempotencyKey: `key-${index}`,
      targetResource: 'PROJ',
      payload,
      approvalId: `apr-${index}`,
      actorSub: 'alice',
      traceId: 'trace-bench',
      facts: allowedFacts,
    });
    const elapsed = performance.now() - started;
    if (!result.ok || result.receipt !== `FAKE-${index + 1}`) {
      throw new Error('bench skipped an approved call');
    }
    if (index >= warmup) durations.push(elapsed);
  }
  if (tickets !== total) throw new Error('bench skipped tickets');
  durations.sort((left, right) => left - right);
  return percentile(durations, 95);
}

function percentile(sorted: readonly number[], rank: number): number {
  const index = Math.min(sorted.length - 1, Math.ceil((rank / 100) * sorted.length) - 1);
  return sorted.at(index) ?? 0;
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const p95 = await measureBroker();
  process.stdout.write(`broker p95 ${p95.toFixed(2)} ms\n`);
  if (p95 > BROKER_BUDGET_MS) process.exitCode = 1;
}
