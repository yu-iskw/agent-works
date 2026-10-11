import { pathToFileURL } from 'node:url';

import { createExportLog, drain, verifyChain } from './exporter.js';

import type { OutboxEvent } from '@agent-works/domain';

const budgetEventsPerSecond = 2000;
const warmupCount = 100;
const bearer = 'Bearer super-secret-token';
const oauthRef = 'https://files.example/?oauth_token=super-secret-token';
const occurredAt = '2026-10-10T10:00:00.000Z';

export function measureExportEventsPerSecond(count: number): number {
  drain(sample(Math.min(warmupCount, count), 'warm'), createExportLog());
  const log = createExportLog();
  const events = sample(count, 'run');
  const started = performance.now();
  const receipts = drain(events, log);
  const elapsed = performance.now() - started;
  if (receipts.length !== count || receipts.some((receipt) => receipt !== 'exported')) {
    throw new Error('bench export');
  }
  if (verifyChain(log.links()) !== 'intact') throw new Error('bench chain');
  if (elapsed <= 0) throw new Error('bench clock');
  return (count / elapsed) * 1000;
}

function sample(count: number, prefix: string): OutboxEvent[] {
  const events: OutboxEvent[] = [];
  for (let index = 0; index < count; index += 1) {
    events.push({
      destination: 'audit',
      event: {
        eventId: `${prefix}-${index}`,
        eventType: 'task',
        schemaVersion: '1',
        occurredAt,
        taskId: 'task-1',
        stepId: 'submit',
        traceId: 'trace',
        initiatorSubject: 'alice',
        agentPrincipal: 'agent:memory',
        tool: null,
        policyDecisionId: null,
        approvalId: null,
        requestDigestSha256: null,
        outcome: bearer,
        externalObjectRef: oauthRef,
        prevDigest: null,
      },
    });
  }
  return events;
}

function isDirectRun(): boolean {
  return import.meta.url === pathToFileURL(process.argv[1]).href;
}

if (isDirectRun()) {
  const rate = measureExportEventsPerSecond(4000);
  process.stdout.write(`export ${rate.toFixed(0)} events/s\n`);
  if (rate < budgetEventsPerSecond) process.exitCode = 1;
}
