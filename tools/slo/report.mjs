import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { parseEventJsonLines } from '../../apps/api/dist/telemetry/events.js';
import { sloReport } from '../../apps/api/dist/telemetry/slo.js';

export function reportFiles(eventPath, targetPath) {
  const events = parseEventJsonLines(readFileSync(eventPath, 'utf8'));
  const targets = JSON.parse(readFileSync(targetPath, 'utf8'));
  return sloReport(events, targets);
}
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    const report = reportFiles(process.argv[2], process.argv[3]);
    process.stdout.write(JSON.stringify(report, null, 2) + '\n');
    if (
      [
        report.acceptance,
        report.approvalPersistence,
        report.auditCapture,
        report.duplicateSideEffects,
      ].some((metric) => metric.verdict === 'fail')
    )
      process.exitCode = 2;
  } catch {
    process.stderr.write('Invalid redacted SLO fixture.\n');
    process.exitCode = 1;
  }
}
