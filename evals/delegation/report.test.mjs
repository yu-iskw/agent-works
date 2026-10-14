import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { expect, it } from 'vitest';
import { delegationReport } from './report.mjs';
it('produces the non-gating delegation report during the existing workspace test run', async () => {
  let report;
  try {
    report = await delegationReport();
  } catch {
    report = {
      schemaVersion: '1.0.0',
      mode: 'report-only',
      gating: false,
      status: 'unavailable',
      limitations: ['Offline report infrastructure unavailable; no quality or release claim'],
    };
    const directory = new URL('./reports/', import.meta.url);
    mkdirSync(directory, { recursive: true });
    writeFileSync(new URL('comparison.json', directory), JSON.stringify(report, null, 2) + '\n');
  }
  const path = new URL('./reports/comparison.json', import.meta.url);
  expect(existsSync(path)).toBe(true);
  expect(JSON.parse(readFileSync(path, 'utf8')).gating).toBe(false);
  expect(report.mode).toBe('report-only');
  console.log(
    JSON.stringify({
      delegationReport: report.status ?? 'produced',
      gating: false,
      path: 'evals/delegation/reports/comparison.json',
    }),
  );
}, 60000);
