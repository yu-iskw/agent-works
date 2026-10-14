import { describe, expect, it } from 'vitest';

import { createMemoryLedgerPort } from '../ports/memory/ledger-port.js';
import { createMemoryWorkflowPort } from '../ports/memory/workflow.js';
import { createLocalEngine } from '../workflow/local-engine.js';
import { createMemoryWorkflowLog } from '../workflow/workflow-log.js';

import { retentionSweepPlan, runRetentionSweep, sweepRetention } from './retention-sweeper.js';
import { EXPIRED, governanceFixture, recordFixture, SECRET } from './test-fixtures.js';

describe('retention local workflow integration', () => {
  it('runs through checkpoint/receipt recovery and emits safe count receipts', async () => {
    const { port, store } = await governanceFixture();
    await store.put(recordFixture(), SECRET);
    const workflow = createMemoryWorkflowPort();
    const log = createMemoryWorkflowLog();
    const ledger = createMemoryLedgerPort(() => EXPIRED);
    const engine = createLocalEngine({ workflow, log, ledger, now: () => EXPIRED });
    const taskId = 'retention-maintenance-1';
    const result = await runRetentionSweep(engine, port, taskId, () => EXPIRED);
    expect(result.status).toBe('COMPLETED');
    expect(result.receipts).toEqual([
      { stepId: 'governance-retention', body: '{"purged":1,"held":0}' },
    ]);
    expect(JSON.stringify(result)).not.toContain(SECRET);
    expect((await runRetentionSweep(engine, port, taskId, () => EXPIRED)).status).toBe('COMPLETED');
    expect((await port.snapshot()).audit.filter((event) => event.type === 'purge')).toHaveLength(1);
  });
  it('honors cancellation before the purge transaction', async () => {
    const { port, store } = await governanceFixture();
    await store.put(recordFixture(), SECRET);
    const signal = AbortSignal.abort();
    const plan = retentionSweepPlan(port, 'maintenance', () => EXPIRED);
    await expect(plan.steps[0].run({ signal })).rejects.toThrow();
    expect((await port.snapshot()).artifacts).toHaveLength(1);
  });
  it('rejects invalid limits and makes progress across bounded batches', async () => {
    const { port, store } = await governanceFixture();
    for (const id of ['a', 'b', 'c']) await store.put(recordFixture(id), SECRET);
    for (const limit of [0, -1, 1.5, 10001])
      await expect(sweepRetention(port, EXPIRED, limit)).rejects.toThrow('limit');
    expect((await sweepRetention(port, EXPIRED, 1)).purged).toEqual(['a']);
    expect((await sweepRetention(port, EXPIRED, 1)).purged).toEqual(['b']);
    expect((await sweepRetention(port, EXPIRED, 1)).purged).toEqual(['c']);
  });
  it('concurrent sweeps serialize and never duplicate purge events', async () => {
    const { port, store } = await governanceFixture();
    await store.put(recordFixture(), SECRET);
    const reports = await Promise.all([
      sweepRetention(port, EXPIRED),
      sweepRetention(port, EXPIRED),
    ]);
    expect(reports.flatMap((report) => report.purged)).toEqual(['artifact-1']);
    expect((await port.snapshot()).audit.filter((event) => event.type === 'purge')).toHaveLength(1);
  });
});
