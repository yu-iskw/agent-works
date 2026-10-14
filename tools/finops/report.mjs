import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { costReport } from '../../apps/api/dist/finops/model.js';

export function reportFile(path) {
  const input = JSON.parse(readFileSync(path, 'utf8'));
  return costReport(input.traffic, input.prices);
}
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    process.stdout.write(JSON.stringify(reportFile(process.argv[2]), null, 2) + '\n');
  } catch {
    process.stderr.write('Invalid PLACEHOLDER cost fixture.\n');
    process.exitCode = 1;
  }
}
