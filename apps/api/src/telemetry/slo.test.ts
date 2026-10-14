import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { parseEventJsonLines } from './events.js';
import { percentile95, sloReport } from './slo.js';

const events = parseEventJsonLines(
  // eslint-disable-next-line security/detect-non-literal-fs-filename
  readFileSync(new URL('../../../../tools/slo/fixtures/events.jsonl', import.meta.url), 'utf8'),
);
const targets = {
  approval: 'PLACEHOLDER' as const,
  acceptanceP95Ms: 3000,
  approvalPersistenceP95Ms: 2000,
};
describe('recorded offline SLO evidence', () => {
  it('reports deterministic fixture latency, receipts and duplicates (snapshot)', () => {
    expect(sloReport(events, targets)).toMatchSnapshot();
    expect(sloReport([...events].reverse(), targets)).toEqual(sloReport(events, targets));
  });
  it('fails a seeded missing audit receipt', () => {
    const report = sloReport(
      events.filter((event) => event.kind !== 'audit.captured'),
      targets,
    );
    expect(report.auditCapture.verdict).toBe('fail');
    expect(report.auditCapture.matched).toBe(0);
  });
  it('fails unexpected and duplicate captures even when all receipts are absent', () => {
    const capturesOnly = events.filter((event) => event.kind !== 'tool.receipt');
    expect(sloReport(capturesOnly, targets).auditCapture).toMatchObject({
      receipts: 0,
      ratio: null,
      verdict: 'fail',
    });
    const capture = events.find((event) => event.kind === 'audit.captured');
    if (capture === undefined) throw new Error('capture fixture');
    expect(
      sloReport([...capturesOnly, { ...capture, event_id: events[0].session_id }], targets)
        .auditCapture.verdict,
    ).toBe('fail');
  });
  it('makes the SLO report CLI fail when receipts are removed', () => {
    const root = fileURLToPath(new URL('../../../../', import.meta.url));
    // The CLI imports build output: compile current sources to avoid testing stale artifacts.
    execFileSync('pnpm', ['--filter', '@agent-works/api', 'build'], { cwd: root, stdio: 'pipe' });
    const directory = mkdtempSync(join(tmpdir(), 'slo-no-receipts-'));
    try {
      const eventPath = join(directory, 'events.jsonl');
      // eslint-disable-next-line security/detect-non-literal-fs-filename -- temp dir path from mkdtempSync
      writeFileSync(
        eventPath,
        events
          .filter((event) => event.kind !== 'tool.receipt')
          .map((event) => JSON.stringify(event))
          .join('\n') + '\n',
      );
      const result = spawnSync(
        process.execPath,
        ['tools/slo/report.mjs', eventPath, 'tools/slo/fixtures/targets.json'],
        { cwd: root, encoding: 'utf8' },
      );
      expect(result.stderr).toBe('');
      expect(result.status).toBe(2);
      const report = JSON.parse(result.stdout) as { auditCapture: { verdict: string } };
      expect(report.auditCapture.verdict).toBe('fail');
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  }, 30_000);
  it('distinguishes replayed telemetry from duplicate external effects', () => {
    expect(sloReport([...events, ...events], targets).duplicateSideEffects.count).toBe(0);
    const receipt = events.find((event) => event.kind === 'tool.receipt');
    if (receipt === undefined) throw new Error('receipt fixture');
    const other = events.find((event) => event.kind === 'task.accepted');
    if (other === undefined) throw new Error('accept fixture');
    const report = sloReport([...events, { ...receipt, event_id: other.session_id }], targets);
    expect(report.duplicateSideEffects.count).toBe(1);
    expect(report.duplicateSideEffects.verdict).toBe('fail');
  });
  it('rejects changed event identities', () => {
    expect(() =>
      sloReport([...events, { ...events[0], latency_ms: events[0].latency_ms + 1 }], targets),
    ).toThrow('identity conflict');
  });
  it('does not treat absent measurements as a passed SLO', () => {
    const report = sloReport([], targets);
    expect(report.acceptance.verdict).toBe('no_data');
    expect(report.auditCapture.ratio).toBeNull();
    expect(report.auditCapture.verdict).toBe('no_data');
    expect(percentile95([])).toBeNull();
    expect(percentile95([100, 1, 2])).toBe(100);
  });
});
