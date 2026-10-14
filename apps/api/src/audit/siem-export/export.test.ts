import { readFileSync } from 'node:fs';

import { auditEventSchema } from '@agent-works/domain';
import { describe, expect, it } from 'vitest';

import { auditFixture } from '../../reliability/fixtures.js';
import { createRedactor } from '../../telemetry/events-redaction.js';

import { exportSecurityEvents } from './export.js';
import { projectAudit, verifyExports } from './format.js';
import { createMemorySiemSink } from './memory-sink.js';
import { assertReceiptReconciliation, reconcileReceipts } from './reconcile.js';

const redactor = createRedactor('protected-fixture-redaction-key');
const raw = JSON.parse(
  // eslint-disable-next-line security/detect-non-literal-fs-filename
  readFileSync(
    new URL('../../../../../tools/slo/fixtures/audit-receipts.json', import.meta.url),
    'utf8',
  ),
) as {
  events: unknown[];
  receipts: { taskId: string; stepId: string; tool: string; ref: string; requestDigest: string }[];
};
const events = raw.events.map((event) => auditEventSchema.parse(event));
describe('immutable SIEM write reconciliation', () => {
  it('reconciles every independent fixture side-effect receipt', async () => {
    const sink = createMemorySiemSink();
    await exportSecurityEvents(events, sink, redactor);
    const report = assertReceiptReconciliation(raw.receipts, await sink.read(), redactor);
    expect(report).toMatchObject({
      expected: raw.receipts.length,
      matched: raw.receipts.length,
      pass: true,
    });
  });
  it('fails a seeded missing receipt export', async () => {
    const sink = createMemorySiemSink();
    await exportSecurityEvents(events.slice(1), sink, redactor);
    expect(() => assertReceiptReconciliation(raw.receipts, [], redactor)).toThrow(
      'reconciliation failed',
    );
    expect(reconcileReceipts(raw.receipts, await sink.read(), redactor).pass).toBe(false);
  });
  it('never leaks a canary token or prompt, including malicious labels and unknown fields', async () => {
    const canary = 'CANARY_SECRET_TOKEN_prompt_never_export';
    const event = {
      ...auditFixture(),
      eventId: canary,
      eventType: canary,
      taskId: canary,
      stepId: canary,
      traceId: canary,
      initiatorSubject: canary,
      agentPrincipal: canary,
      tool: canary,
      policyDecisionId: canary,
      approvalId: canary,
      externalObjectRef: canary,
      token: canary,
      prompt: canary,
    };
    const sink = createMemorySiemSink();
    await exportSecurityEvents([event], sink, redactor);
    const output = JSON.stringify(await sink.read());
    expect(output).not.toContain(canary);
    expect(output).not.toContain('prompt');
    expect(output).not.toContain('token');
  });
  it('rejects duplicate and mismatched external receipts', async () => {
    const sink = createMemorySiemSink();
    await exportSecurityEvents(events, sink, redactor);
    const links = await sink.read();
    expect(
      reconcileReceipts([...raw.receipts, raw.receipts[0]], links, redactor).duplicate,
    ).toHaveLength(1);
    expect(reconcileReceipts([{ ...raw.receipts[0], ref: 'wrong' }], links, redactor).pass).toBe(
      false,
    );
  });
  it('deduplicates identical export deliveries, detects tampering and rejects changed identities', async () => {
    const sink = createMemorySiemSink();
    const event = projectAudit(auditFixture(), redactor);
    const first = await sink.append(event);
    expect(await sink.append(event)).toEqual(first);
    expect(await sink.read()).toHaveLength(1);
    expect(() => verifyExports([{ ...first, digest: '0'.repeat(64) }])).toThrow('integrity');
    expect(() => sink.append({ ...event, outcome: 'denied' })).toThrow('identity conflict');
    const copy = await sink.read();
    expect(Object.isFrozen(event)).toBe(true);
    expect(copy).not.toBe(await sink.read());
  });
});
